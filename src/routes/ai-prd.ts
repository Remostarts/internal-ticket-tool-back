import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { Types } from 'mongoose';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePermission } from '../middleware/require-permission.js';
import { asyncHandler } from '../middleware/error-handler.js';
import { AppError } from '../middleware/error-handler.js';
import { assertProjectAccess } from '../services/project-scope.js';
import { extractTextFromBuffer, extractTextFromString } from '../services/prd-parser.js';
import { runPrdBreakdown, commitPrdRun, discardPrdRun } from '../services/ai-prd.js';
import { PrdBreakdownRun } from '../models/prd-breakdown-run.js';
import { Milestone } from '../models/milestone.js';
import { Task } from '../models/task.js';
import { logger } from '../logging/logger.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'text/plain',
      'text/markdown',
    ];
    if (allowed.includes(file.mimetype) || file.originalname.endsWith('.md')) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Use PDF, DOCX, MD, or TXT.'));
    }
  },
});

/** Helper: writes an SSE event frame to an Express response. */
function sseWrite(res: Response, stage: string, message: string, data?: Record<string, unknown>): void {
  const payload = JSON.stringify({ stage, message, ...data });
  res.write(`data: ${payload}\n\n`);
  if (typeof (res as any).flush === 'function') (res as any).flush();
}

/** Asserts a named route param is present (Express guarantees this for matched routes). */
function requireParam(value: string | undefined, name: string): string {
  if (!value) throw new AppError('NOT_FOUND', `Missing route parameter: ${name}`);
  return value;
}

export function createAiPrdRouter(): Router {
  const router = Router();

  /**
   * POST /api/projects/:projectId/ai/prd-breakdown
   *
   * Multipart: file upload (field name "file") OR JSON body { content: string, mode?: "replace"|"append" }.
   * Streams SSE events while the AI generates the plan. Returns a draft PrdBreakdownRun summary.
   */
  router.post(
    '/api/projects/:projectId/ai/prd-breakdown',
    requireAuth,
    requirePermission('prd:write'),
    upload.single('file'),
    async (req: Request, res: Response) => {
      const user = req.sessionUser as any;
      const projectId = requireParam(req.params.projectId, 'projectId');

      await assertProjectAccess(user, projectId);

      // Reject client role explicitly (belt-and-suspenders)
      if ((user as any).role === 'client' || (user as any).kind === 'client') {
        throw new AppError('PERMISSION_DENIED');
      }

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const emitter = {
        emit(stage: string, message: string, data?: Record<string, unknown>) {
          sseWrite(res, stage, message, data);
        },
      };

      try {
        // Stage 1: Check for existing committed run (idempotency)
        emitter.emit('checking', 'Checking for existing breakdown...');
        const existingRun = await PrdBreakdownRun.findOne({
          project: new Types.ObjectId(projectId),
          status: 'committed',
        }).exec();

        const mode = (req.body?.mode as string | undefined) ?? 'replace';

        if (existingRun && mode !== 'replace' && mode !== 'append') {
          sseWrite(res, 'existing_run', 'A committed breakdown already exists.', {
            runId: (existingRun._id as Types.ObjectId).toHexString(),
            requiresChoice: true,
          });
          res.end();
          return;
        }

        if (existingRun && mode === 'replace') {
          emitter.emit('archiving', 'Archiving previous breakdown run...');
          await PrdBreakdownRun.updateOne(
            { _id: existingRun._id },
            { $set: { status: 'archived' } },
          );
          // Hide old tasks from board
          await Task.updateMany(
            { prdRunId: existingRun._id },
            { $set: { visibleOnBoard: false } },
          );
          await Milestone.updateMany(
            { prdRunId: existingRun._id },
            { $set: { visibleOnBoard: false } },
          );
        }

        // Stage 2: Extract text
        emitter.emit('reading', 'Reading PRD content...');
        let text: string;
        let hash: string;

        if (req.file) {
          const extracted = await extractTextFromBuffer(req.file.buffer, req.file.mimetype, req.file.originalname);
          text = extracted.text;
          hash = extracted.hash;
        } else if (req.body?.content) {
          const extracted = extractTextFromString(req.body.content as string);
          text = extracted.text;
          hash = extracted.hash;
        } else {
          throw new AppError('VALIDATION_FAILED', 'Provide a file upload or a content text body.');
        }

        if (text.length < 50) {
          throw new AppError('VALIDATION_FAILED', 'PRD content is too short to analyze.');
        }

        emitter.emit('estimating', 'Estimating infrastructure requirements...');

        // Stage 3: Run AI breakdown
        const summary = await runPrdBreakdown(projectId, user._id.toString(), text, hash, emitter);

        // Final SSE event with full summary
        sseWrite(res, 'completed', 'Draft breakdown ready for review.', { summary });
        res.end();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'AI breakdown failed.';
        logger.error({ err, projectId }, 'PRD breakdown failed');
        sseWrite(res, 'error', message);
        res.end();
      }
    },
  );

  /**
   * GET /api/projects/:projectId/ai/prd-breakdown/:runId
   *
   * Returns the summary for a specific PRD breakdown run.
   */
  router.get(
    '/api/projects/:projectId/ai/prd-breakdown/:runId',
    requireAuth,
    requirePermission('prd:write'),
    asyncHandler(async (req, res) => {
      const user = req.sessionUser as any;
      const projectId = requireParam(req.params.projectId, 'projectId');
      const runId = requireParam(req.params.runId, 'runId');
      await assertProjectAccess(user, projectId);

      const run = await PrdBreakdownRun.findOne({
        _id: new Types.ObjectId(runId),
        project: new Types.ObjectId(projectId),
      }).exec();

      if (!run) throw new AppError('NOT_FOUND', 'PRD breakdown run not found');

      const milestones = await Milestone.find({ prdRunId: run._id }).exec();
      const tasks = await Task.find({ prdRunId: run._id }).exec();

      res.status(200).json({
        runId: (run._id as Types.ObjectId).toHexString(),
        status: run.status,
        milestoneCount: milestones.length,
        taskCount: tasks.length,
        riskSpikeCount: tasks.filter((t) => t.isRiskSpike).length,
        unresolvedDependencyWarnings: run.unresolvedDependencyWarnings,
        infraEstimation: run.infraEstimation,
        milestones: milestones.map((ms) => {
          const msTasks = tasks.filter((t) => t.milestoneId?.toString() === (ms._id as Types.ObjectId).toHexString());
          return {
            id: (ms._id as Types.ObjectId).toHexString(),
            title: ms.title,
            phase: ms.phase,
            deliverables: ms.deliverables,
            taskCount: msTasks.length,
            tasks: msTasks.map((t) => ({
              id: (t._id as Types.ObjectId).toHexString(),
              title: t.title,
              description: t.description,
              priority: t.priority,
              type: t.type,
              isRiskSpike: t.isRiskSpike,
              riskNotes: t.riskNotes,
              acceptanceCriteria: t.acceptanceCriteria,
              blockedByIds: (t.blockedByIds ?? []).map((id: any) => id.toString()),
            })),
          };
        }),
      });
    }),
  );

  /**
   * POST /api/projects/:projectId/ai/prd-breakdown/:runId/commit
   *
   * Commits a draft run: makes all tasks and milestones visible on the board.
   */
  router.post(
    '/api/projects/:projectId/ai/prd-breakdown/:runId/commit',
    requireAuth,
    requirePermission('prd:write'),
    asyncHandler(async (req, res) => {
      const user = req.sessionUser as any;
      const projectId = requireParam(req.params.projectId, 'projectId');
      const runId = requireParam(req.params.runId, 'runId');
      await assertProjectAccess(user, projectId);

      if ((user as any).role === 'client' || (user as any).kind === 'client') {
        throw new AppError('PERMISSION_DENIED');
      }

      await commitPrdRun(runId, projectId);
      res.status(200).json({ ok: true, message: 'Breakdown committed. Tasks are now visible on the board.' });
    }),
  );

  /**
   * DELETE /api/projects/:projectId/ai/prd-breakdown/:runId
   *
   * Discards a draft run and hard-deletes all its tasks and milestones.
   */
  router.delete(
    '/api/projects/:projectId/ai/prd-breakdown/:runId',
    requireAuth,
    requirePermission('prd:write'),
    asyncHandler(async (req, res) => {
      const user = req.sessionUser as any;
      const projectId = requireParam(req.params.projectId, 'projectId');
      const runId = requireParam(req.params.runId, 'runId');
      await assertProjectAccess(user, projectId);

      if ((user as any).role === 'client' || (user as any).kind === 'client') {
        throw new AppError('PERMISSION_DENIED');
      }

      await discardPrdRun(runId, projectId);
      res.status(200).json({ ok: true, message: 'Draft breakdown discarded.' });
    }),
  );

  return router;
}
