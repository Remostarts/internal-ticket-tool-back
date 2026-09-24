import { Types } from 'mongoose';
import { logger } from '../logging/logger.js';
import { Ticket } from '../models/ticket.js';
import { TicketComment } from '../models/ticket-comment.js';
import { Task } from '../models/task.js';
import { writeAudit } from './audit.js';
import { serializeTask, type TaskSummary } from './tasks.js';
import { getTicketDetail } from './tickets.js';
import { assertTicketAccess, type ScopedUser } from './project-scope.js';

const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';

const SYSTEM_PROMPT = `You are a Lead Software Architect and Senior Technical Product Manager.
Your job is to convert raw customer support tickets, client bug reports, or feature requests into exact, crystal-clear, and easy-to-understand engineering tasks.

CRITICAL INSTRUCTIONS ON WORDING & ACCURACY:
1. Translating Customer Language:
   - Customers and clients often submit tickets with emotional, confusing, incomplete, or ambiguous wording.
   - Your task is to decode the root problem or request and write it in exact, professional, and easily understandable software engineering language.
   - Avoid vague generalizations. Spell out exact screens, entities, flows, and expected behavior.
2. Task Title:
   - Must be direct, unambiguous, actionable, and under 90 characters.
   - Must start with an active imperative verb (e.g., "Fix session expiration during checkout redirect", "Implement export to CSV for transaction records", "Resolve 500 error on profile update").
   - Do NOT include internal ticket IDs, client names, or colloquial emotion in the title.
3. Task Description Structure (Markdown):
   You must structure the description cleanly using these exact sections:
   ### Problem Statement
   [Explain the exact issue or feature requested in simple, plain, crystal-clear language so any engineer or stakeholder instantly understands what is happening.]

   ### Technical Scope & Affected Areas
   [Specify which components, API endpoints, database models, frontend views, or third-party integrations need to be created or modified.]

   ### Client Context & Reproduction
   [Original client details, reproduction steps, error logs, or observed vs expected behavior extracted from the ticket.]

   ### Acceptance Criteria
   [2-4 clear, verifiable, bulleted conditions that QA engineers and developers can objectively test to confirm resolution.]

You MUST respond ONLY with a single valid JSON object adhering to this schema (no markdown formatting fences, no introductory or trailing commentary):
{
  "title": "<Direct, actionable, professional task title>",
  "description": "<Structured, crystal-clear markdown description with the headings above>",
  "priority": "<P1|P2|P3|P4>",
  "type": "<feature|bug|refactor|spike>",
  "acceptanceCriteria": [
    "<Clear verifiable criterion 1>",
    "<Clear verifiable criterion 2>"
  ]
}

Priority Calibration:
- "P1": Critical severity (financial loss, complete service outage, data security issue, blocker with zero workaround).
- "P2": High severity (core workflow failure affecting multiple users, no good workaround).
- "P3": Medium severity (normal feature request, standard non-critical bug).
- "P4": Low severity (minor UI defect, styling glitch, wording/copy change).`;

interface AiTaskDraft {
  title: string;
  description: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  type: 'feature' | 'bug' | 'refactor' | 'spike';
  acceptanceCriteria: string[];
}

function parseAiJson(raw: string): AiTaskDraft | null {
  try {
    // Strip markdown code fences if model included them
    let clean = raw.trim();
    if (clean.startsWith('```')) {
      clean = clean.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '').trim();
    }
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed.title === 'string' && typeof parsed.description === 'string') {
      return {
        title: parsed.title.trim(),
        description: parsed.description.trim(),
        priority: ['P1', 'P2', 'P3', 'P4'].includes(parsed.priority) ? parsed.priority : 'P3',
        type: ['feature', 'bug', 'refactor', 'spike'].includes(parsed.type) ? parsed.type : 'feature',
        acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria)
          ? parsed.acceptanceCriteria.map((c: any) => String(c).trim()).filter(Boolean)
          : [],
      };
    }
  } catch (err) {
    logger.warn({ err, raw }, 'Failed to parse AI response as JSON for ticket conversion');
  }
  return null;
}

function buildFallbackDraft(ticket: any): AiTaskDraft {
  const isBug = ticket.type === 'bug' || /error|fail|bug|broken|crash|issue/i.test(ticket.title + ticket.description);
  const title = ticket.title.length > 80 ? ticket.title.slice(0, 80) : ticket.title;

  return {
    title: isBug ? `Investigate and fix: ${title}` : `Implement feature request: ${title}`,
    description: `### Overview & Context\nClient submitted ticket **${ticket.reference}**:\n\n> ${ticket.description}\n\n### Technical Scope\n- Analyze reported behavior and underlying services.\n- Implement code changes required to satisfy customer requirements.\n\n### Definition of Done\n- Verified resolution on staging and production environments.\n- Client confirmation received.`,
    priority: (ticket.priority as any) || 'P3',
    type: isBug ? 'bug' : 'feature',
    acceptanceCriteria: [
      `Root cause of "${ticket.title}" identified and resolved.`,
      `Functionality tested and verified across supported environments.`,
    ],
  };
}

export async function convertTicketToTaskWithAi(
  user: ScopedUser,
  ticketIdOrReference: string,
): Promise<{ task: TaskSummary; ticket: any }> {
  // 1. Fetch ticket and verify access
  const query = Types.ObjectId.isValid(ticketIdOrReference)
    ? { $or: [{ _id: new Types.ObjectId(ticketIdOrReference) }, { reference: ticketIdOrReference }] }
    : { reference: ticketIdOrReference };

  const ticket = await Ticket.findOne(query)
    .populate('project')
    .populate('requester', 'username profile')
    .exec();

  if (!ticket) {
    const error: any = new Error('Ticket not found');
    error.statusCode = 404;
    throw error;
  }

  await assertTicketAccess(user, ticket as any);

  // Retrieve existing comments to give AI full context
  const comments = await TicketComment.find({ ticket: ticket._id })
    .sort({ createdAt: 1 })
    .populate('author', 'username profile')
    .lean()
    .exec();

  const conversationSummary = comments
    .map((c) => `[${(c as any).author?.profile?.fullName || (c as any).author?.username || 'User'}]: ${c.content}`)
    .join('\n');

  const ticketPromptContext = `
Ticket Reference: ${ticket.reference}
Current Category: ${ticket.type}
Reported Priority: ${ticket.priority}
Title: ${ticket.title}
Original Description: ${ticket.description}
${conversationSummary ? `Discussion Thread:\n${conversationSummary}` : ''}
`.trim();

  // 2. Call AI (with intelligent fallback)
  let taskDraft: AiTaskDraft | null = null;
  const apiKey = process.env.NVIDIA_API_KEY;

  if (apiKey) {
    try {
      const res = await fetch(NVIDIA_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Analyze this customer ticket and generate the engineering task JSON:\n\n${ticketPromptContext}` },
          ],
          temperature: 0.2,
          max_tokens: 1500,
          stream: false,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          taskDraft = parseAiJson(content);
        }
      } else {
        logger.warn({ status: res.status }, 'NVIDIA API returned non-OK status during ticket conversion');
      }
    } catch (err) {
      logger.warn({ err }, 'Error calling NVIDIA API for ticket conversion, falling back to heuristic');
    }
  }

  if (!taskDraft) {
    taskDraft = buildFallbackDraft(ticket);
  }

  // 3. Count existing backlog tasks to assign proper position
  const count = await Task.countDocuments({
    project: ticket.project,
    column: 'backlog',
    parent: null,
  }).exec();

  // 4. Create the Task in Project Backlog
  const createdTask = await Task.create({
    project: ticket.project,
    creator: new Types.ObjectId(user.id),
    title: taskDraft.title,
    description: taskDraft.description,
    priority: taskDraft.priority,
    column: 'backlog',
    position: count,
    ticket: ticket._id,
    type: taskDraft.type,
    acceptanceCriteria: taskDraft.acceptanceCriteria.map((text) => ({ text, done: false })),
    featureChecklist: {
      figma: false,
      development: false,
      testing: false,
      deployed: false,
    },
    visibleOnBoard: true,
    isPersonal: false,
  });

  // 5. Post an automated system comment to the ticket activity thread
  await TicketComment.create({
    ticket: ticket._id,
    author: new Types.ObjectId(user.id),
    content: `✨ AI generated engineering task "${taskDraft.title}" (${taskDraft.priority}) and placed it into the project Backlog.`,
    visibility: 'public',
    isSystemEvent: true,
  });

  // 6. Audit Trail
  await writeAudit({
    userId: user.id,
    action: 'task.created',
    resourceType: 'task',
    resourceId: createdTask._id.toHexString(),
    details: {
      fromTicket: ticket.reference,
      title: createdTask.title,
      column: 'backlog',
      generatedByAi: Boolean(apiKey),
    },
  });

  const populated = await Task.findById(createdTask._id).populate('assignee', 'username profile').lean().exec();
  const serializedTask = serializeTask(populated);

  // Return task and refreshed ticket details
  const updatedTicket = await getTicketDetail(user, ticket._id.toHexString());

  return {
    task: serializedTask,
    ticket: updatedTicket,
  };
}
