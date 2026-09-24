import { Router } from 'express';
import {
  createTaskSchema,
  moveTaskSchema,
  updateTaskSchema,
} from '@/shared';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePermission } from '../middleware/require-permission.js';
import {
  getProjectBoard,
  getTaskSubtasks,
  createTask,
  updateTask,
  moveTask,
  deleteTask,
  getWatchtowerData,
  getTaskById,
} from '../services/tasks.js';

export function createTasksRouter(): Router {
  const router = Router();

  // Get Kanban board for a project or personal board
  router.get(
    '/api/projects/:projectId/board',
    requireAuth,
    requirePermission('tasks:read'),
    asyncHandler(async (req, res) => {
      const personalOnly = req.query.personal === 'true' || req.params.projectId === 'personal';
      const userId = req.query.userId as string | undefined;
      const board = await getProjectBoard(req.sessionUser as any, req.params.projectId as string, {
        personalOnly,
        userId,
      });
      res.status(200).json(board);
    }),
  );

  // Get Personal Kanban board across all projects
  router.get(
    '/api/tasks/personal-board',
    requireAuth,
    requirePermission('tasks:read'),
    asyncHandler(async (req, res) => {
      const board = await getProjectBoard(req.sessionUser as any, 'personal', { personalOnly: true });
      res.status(200).json(board);
    }),
  );

  // Get Subtasks for a task
  router.get(
    '/api/tasks/:id/subtasks',
    requireAuth,
    requirePermission('tasks:read'),
    asyncHandler(async (req, res) => {
      const subtasks = await getTaskSubtasks(req.sessionUser as any, req.params.id as string);
      res.status(200).json(subtasks);
    }),
  );

  // Get single task by ID
  router.get(
    '/api/tasks/:id',
    requireAuth,
    requirePermission('tasks:read'),
    asyncHandler(async (req, res) => {
      const task = await getTaskById(req.sessionUser as any, req.params.id as string);
      res.status(200).json(task);
    }),
  );

  // Create Task or Subtask
  router.post(
    '/api/tasks',
    requireAuth,
    requirePermission('tasks:write'),
    asyncHandler(async (req, res) => {
      const input = createTaskSchema.parse(req.body);
      const task = await createTask(req.sessionUser as any, input);
      res.status(201).json(task);
    }),
  );

  // Update Task or Checklist
  router.patch(
    '/api/tasks/:id',
    requireAuth,
    requirePermission('tasks:write'),
    asyncHandler(async (req, res) => {
      const input = updateTaskSchema.parse(req.body);
      const updated = await updateTask(req.sessionUser as any, req.params.id as string, input);
      res.status(200).json(updated);
    }),
  );

  // Move Task on Kanban board (Drag & Drop or Touch Move)
  router.post(
    '/api/tasks/:id/move',
    requireAuth,
    requirePermission('tasks:write'),
    asyncHandler(async (req, res) => {
      const input = moveTaskSchema.parse(req.body);
      const updated = await moveTask(req.sessionUser as any, req.params.id as string, input);
      res.status(200).json(updated);
    }),
  );

  // Watchtower Attention View
  router.get(
    '/api/watchtower',
    requireAuth,
    requirePermission('tasks:read'),
    asyncHandler(async (req, res) => {
      const projectId = req.query.projectId as string | undefined;
      const data = await getWatchtowerData(req.sessionUser as any, projectId);
      res.status(200).json(data);
    }),
  );

  // Delete Task
  router.delete(
    '/api/tasks/:id',
    requireAuth,
    requirePermission('tasks:write'),
    asyncHandler(async (req, res) => {
      await deleteTask(req.sessionUser as any, req.params.id as string);
      res.status(204).end();
    }),
  );

  return router;
}
