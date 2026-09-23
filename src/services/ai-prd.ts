import { Types } from 'mongoose';

import { logger } from '../logging/logger.js';
import { Milestone } from '../models/milestone.js';
import { PrdBreakdownRun } from '../models/prd-breakdown-run.js';
import { Task } from '../models/task.js';
import type { PrdRunStatus } from '@/shared';

const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';

export interface SseEmitter {
  emit(stage: string, message: string, data?: Record<string, unknown>): void;
}

const SYSTEM_PROMPT = `You are a senior software architect and project manager. Your task is to analyze a Product Requirements Document (PRD) and decompose it into a structured project plan.

You MUST respond with a single, valid JSON object matching this exact schema. No markdown fences, no commentary before or after the JSON.

{
  "infraEstimation": {
    "apiCount": <number of custom API endpoints needed>,
    "services": ["e.g. Resend (Email)", "Twilio (SMS)", "Stripe (Payments)", "AWS S3 (Storage)"],
    "notes": "brief explanation"
  },
  "milestones": [
    {
      "tempId": "M1",
      "title": "Milestone title",
      "description": "What this milestone achieves",
      "phase": "discovery|design|development|testing|deployment|maintenance",
      "deliverables": ["Tangible output 1", "Tangible output 2"],
      "tasks": [
        {
          "tempId": "T1",
          "title": "Task title",
          "description": "Clear technical description",
          "priority": "P1|P2|P3|P4",
          "type": "feature|spike|refactor|technical_debt|bug",
          "isRiskSpike": false,
          "riskNotes": "",
          "acceptanceCriteria": ["User can...", "System must..."],
          "blockedBy": ["T2", "T3"],
          "storyPoints": 3
        }
      ]
    }
  ]
}

Rules:
- Use tempIds T1, T2, ... for tasks and M1, M2, ... for milestones. NEVER use real database IDs.
- blockedBy must only reference tempIds of OTHER tasks, never the task itself.
- Sequence milestones and tasks in chronological order.
- Phases must follow this order: discovery -> design -> development -> testing -> deployment -> maintenance.
- Mark any unclear or high-complexity area as isRiskSpike: true with riskNotes explaining the risk.
- P1=Critical, P2=High, P3=Medium, P4=Low.
- storyPoints must be a Fibonacci number: 1, 2, 3, 5, 8, 13.`;

/**
 * Streams the LLM response and accumulates the full text.
 * Calls emitter.emit() for each SSE chunk description.
 */
async function streamNvidiaCompletion(prdText: string, emitter: SseEmitter): Promise<string> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY environment variable is not set');

  const payload = JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Analyze this PRD and produce the structured JSON plan:\n\n${prdText}` },
    ],
    temperature: 0.4,
    top_p: 0.9,
    max_tokens: 16384,
    reasoning_budget: 8192,
    chat_template_kwargs: { enable_thinking: true },
    stream: true,
  });

  let accumulated = '';
  let chunkCount = 0;
  
  // Use native fetch to avoid ECONNRESET issues common with legacy https.request on long streams
  const res = await fetch(NVIDIA_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: payload,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`NVIDIA API Error ${res.status}: ${errText}`);
  }

  if (!res.body) {
    throw new Error('No response body from NVIDIA API');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // keep the last incomplete line in the buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        
        try {
          const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const content = parsed.choices?.[0]?.delta?.content ?? '';
          if (content) {
            accumulated += content;
            chunkCount++;
            if (chunkCount % 20 === 0) {
              emitter.emit('generating', `Receiving AI response... (${chunkCount} chunks)`);
            }
          }
        } catch {
          // partial SSE chunk or invalid JSON, skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return accumulated;
}

/**
 * Parses LLM output, extracting the first valid JSON object from the response.
 */
function extractJson(raw: string): unknown {
  // Strip potential markdown fences
  const stripped = raw.replace(/```json\n?|```\n?/g, '').trim();
  // Find the first { and last }
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in AI response');
  return JSON.parse(stripped.slice(start, end + 1));
}

interface AiTask {
  tempId: string;
  title: string;
  description?: string;
  priority?: string;
  type?: string;
  isRiskSpike?: boolean;
  riskNotes?: string;
  acceptanceCriteria?: string[];
  blockedBy?: string[];
  storyPoints?: number;
}

interface AiMilestone {
  tempId: string;
  title: string;
  description?: string;
  phase: string;
  deliverables?: string[];
  tasks: AiTask[];
}

interface AiOutput {
  infraEstimation?: {
    apiCount?: number;
    services?: string[];
    notes?: string;
  };
  milestones: AiMilestone[];
}

const VALID_PHASES = ['discovery', 'design', 'development', 'testing', 'deployment', 'maintenance'] as const;
const VALID_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
const VALID_TYPES = ['feature', 'bug', 'spike', 'refactor', 'technical_debt'] as const;

function validatePhase(phase: string): typeof VALID_PHASES[number] {
  return VALID_PHASES.includes(phase as any) ? (phase as typeof VALID_PHASES[number]) : 'development';
}
function validatePriority(p: string | undefined): string {
  return VALID_PRIORITIES.includes(p as any) ? (p as string) : 'P3';
}
function validateType(t: string | undefined): string | null {
  return VALID_TYPES.includes(t as any) ? (t as string) : 'feature';
}

export interface PrdBreakdownSummary {
  runId: string;
  status: PrdRunStatus;
  milestoneCount: number;
  taskCount: number;
  riskSpikeCount: number;
  unresolvedDependencyWarnings: string[];
  infraEstimation: {
    apiCount: number;
    services: string[];
    notes: string;
  };
  milestones: Array<{
    id: string;
    title: string;
    phase: string;
    taskCount: number;
    riskTaskCount: number;
  }>;
}

/**
 * Full PRD breakdown pipeline with two-pass dependency resolution.
 *
 * Pass 1: Create Milestone + Task documents (blockedByIds/blocksIds empty).
 * Pass 2: Walk the AI dependency graph, resolve tempIds → ObjectIds, bulk-update.
 */
export async function runPrdBreakdown(
  projectId: string,
  userId: string,
  prdText: string,
  sourceHash: string,
  emitter: SseEmitter,
): Promise<PrdBreakdownSummary> {
  const projectObjectId = new Types.ObjectId(projectId);
  const userObjectId = new Types.ObjectId(userId);

  // Create draft run record
  const draftRun = await PrdBreakdownRun.create({
    project: projectObjectId,
    sourceHash,
    createdBy: userObjectId,
    status: 'draft',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h TTL
  });
  const runObjectId = draftRun._id as Types.ObjectId;

  try {
    emitter.emit('generating', 'Sending PRD to AI model for analysis...');
    const rawResponse = await streamNvidiaCompletion(prdText, emitter);

    emitter.emit('parsing', 'Parsing AI response...');
    const aiOutput = extractJson(rawResponse) as AiOutput;

    if (!Array.isArray(aiOutput.milestones)) {
      throw new Error('AI response did not contain a milestones array');
    }

    emitter.emit('persisting', 'Creating milestones and tasks (Pass 1)...');

    // ── PASS 1: Create all documents, build tempId → ObjectId map ──────────────
    const tempIdMap = new Map<string, Types.ObjectId>(); // T1, T2, ... → ObjectId
    const milestoneIds: Types.ObjectId[] = [];
    const taskIds: Types.ObjectId[] = [];
    const allRawTasks: Array<{ tempId: string; blockedBy: string[]; taskObjectId: Types.ObjectId }> = [];

    for (const aiMs of aiOutput.milestones) {
      const milestone = await Milestone.create({
        project: projectObjectId,
        title: aiMs.title,
        description: aiMs.description ?? '',
        phase: validatePhase(aiMs.phase),
        deliverables: aiMs.deliverables ?? [],
        status: 'pending',
        prdRunId: runObjectId,
        visibleOnBoard: false,
      });
      const msObjectId = milestone._id as Types.ObjectId;
      milestoneIds.push(msObjectId);

      const mileTasks = Array.isArray(aiMs.tasks) ? aiMs.tasks : [];
      for (const aiTask of mileTasks) {
        const task = await Task.create({
          project: projectObjectId,
          title: aiTask.title,
          description: aiTask.description ?? '',
          priority: validatePriority(aiTask.priority),
          column: 'todo',
          position: taskIds.length,
          creator: userObjectId,
          milestoneId: msObjectId,
          prdRunId: runObjectId,
          type: validateType(aiTask.type),
          isRiskSpike: aiTask.isRiskSpike ?? false,
          riskNotes: aiTask.riskNotes ?? '',
          acceptanceCriteria: (aiTask.acceptanceCriteria ?? []).map((text) => ({ text, done: false })),
          blockedByIds: [], // filled in Pass 2
          blocksIds: [],    // filled in Pass 2
          visibleOnBoard: false, // draft — not on board yet
        });
        const taskObjectId = task._id as Types.ObjectId;
        taskIds.push(taskObjectId);
        tempIdMap.set(aiTask.tempId, taskObjectId);
        allRawTasks.push({
          tempId: aiTask.tempId,
          blockedBy: aiTask.blockedBy ?? [],
          taskObjectId,
        });
      }
    }

    // ── PASS 2: Resolve dependencies, detect cycles, bulk-update ───────────────
    emitter.emit('dependencies', 'Resolving task dependencies (Pass 2)...');
    const unresolvedWarnings: string[] = [];
    const resolvedEdges = new Map<string, Set<string>>(); // tempId → Set of blocked-by tempIds

    for (const raw of allRawTasks) {
      const resolvedBlockedBy: Types.ObjectId[] = [];
      for (const depTempId of raw.blockedBy) {
        const depObjectId = tempIdMap.get(depTempId);
        if (!depObjectId) {
          const warning = `Task ${raw.tempId} references unknown dependency ${depTempId} — skipped`;
          unresolvedWarnings.push(warning);
          logger.warn({ runId: runObjectId.toHexString() }, warning);
          continue;
        }
        // Cycle detection: A→B and B→A
        const reverseEdges = resolvedEdges.get(depTempId);
        if (reverseEdges?.has(raw.tempId)) {
          const warning = `Cycle detected: ${raw.tempId} ↔ ${depTempId}. Dropping ${depTempId}→${raw.tempId} direction.`;
          unresolvedWarnings.push(warning);
          logger.warn({ runId: runObjectId.toHexString() }, warning);
          continue;
        }
        resolvedBlockedBy.push(depObjectId);
        if (!resolvedEdges.has(raw.tempId)) resolvedEdges.set(raw.tempId, new Set());
        resolvedEdges.get(raw.tempId)!.add(depTempId);
      }

      if (resolvedBlockedBy.length > 0) {
        await Task.updateOne(
          { _id: raw.taskObjectId },
          { $set: { blockedByIds: resolvedBlockedBy } },
        );
        // Update blocksIds on the blocking tasks
        await Task.updateMany(
          { _id: { $in: resolvedBlockedBy } },
          { $addToSet: { blocksIds: raw.taskObjectId } },
        );
      }
    }

    // Save summary data to the run
    const infra = aiOutput.infraEstimation ?? {};
    await PrdBreakdownRun.updateOne(
      { _id: runObjectId },
      {
        $set: {
          milestoneIds,
          taskIds,
          unresolvedDependencyWarnings: unresolvedWarnings,
          infraEstimation: {
            apiCount: infra.apiCount ?? 0,
            services: infra.services ?? [],
            notes: infra.notes ?? '',
          },
        },
      },
    );

    emitter.emit('done', 'Draft breakdown complete. Awaiting review.');

    // Build summary for the frontend review screen
    const milestoneDocs = await Milestone.find({ prdRunId: runObjectId }).exec();
    const taskDocs = await Task.find({ prdRunId: runObjectId }).exec();
    const riskCount = taskDocs.filter((t) => t.isRiskSpike).length;

    return {
      runId: runObjectId.toHexString(),
      status: 'draft',
      milestoneCount: milestoneDocs.length,
      taskCount: taskDocs.length,
      riskSpikeCount: riskCount,
      unresolvedDependencyWarnings: unresolvedWarnings,
      infraEstimation: {
        apiCount: infra.apiCount ?? 0,
        services: infra.services ?? [],
        notes: infra.notes ?? '',
      },
      milestones: milestoneDocs.map((ms) => {
        const msTasks = taskDocs.filter((t) => t.milestoneId?.toString() === (ms._id as Types.ObjectId).toHexString());
        return {
          id: (ms._id as Types.ObjectId).toHexString(),
          title: ms.title,
          phase: ms.phase,
          taskCount: msTasks.length,
          riskTaskCount: msTasks.filter((t) => t.isRiskSpike).length,
        };
      }),
    };
  } catch (err) {
    // Mark run as discarded on failure, but keep for debugging
    await PrdBreakdownRun.updateOne({ _id: runObjectId }, { $set: { status: 'discarded' } });
    throw err;
  }
}

/**
 * Commits a draft run: sets all tasks/milestones as visibleOnBoard=true and status=committed.
 * Tasks land in the 'todo' column.
 */
export async function commitPrdRun(runId: string, projectId: string): Promise<void> {
  const run = await PrdBreakdownRun.findOne({
    _id: new Types.ObjectId(runId),
    project: new Types.ObjectId(projectId),
    status: 'draft',
  }).exec();

  if (!run) throw new Error('Draft run not found or already committed');

  await Task.updateMany(
    { prdRunId: new Types.ObjectId(runId) },
    { $set: { visibleOnBoard: true } },
  );
  await Milestone.updateMany(
    { prdRunId: new Types.ObjectId(runId) },
    { $set: { visibleOnBoard: true } },
  );
  await PrdBreakdownRun.updateOne(
    { _id: new Types.ObjectId(runId) },
    { $set: { status: 'committed', expiresAt: null } },
  );
}

/**
 * Discards a draft run: hard-deletes all its tasks and milestones.
 */
export async function discardPrdRun(runId: string, projectId: string): Promise<void> {
  const run = await PrdBreakdownRun.findOne({
    _id: new Types.ObjectId(runId),
    project: new Types.ObjectId(projectId),
    status: 'draft',
  }).exec();

  if (!run) throw new Error('Draft run not found or already committed');

  await Task.deleteMany({ prdRunId: new Types.ObjectId(runId) });
  await Milestone.deleteMany({ prdRunId: new Types.ObjectId(runId) });
  await PrdBreakdownRun.deleteOne({ _id: new Types.ObjectId(runId) });
}
