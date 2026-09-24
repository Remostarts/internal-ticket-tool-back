import { z } from 'zod';
import { PRIORITIES } from '../priority.js';

export const TASK_COLUMNS = ['backlog', 'todo', 'in-progress', 'testing', 'deployed'] as const;
export type TaskColumn = (typeof TASK_COLUMNS)[number];

export const TASK_COLUMN_LABELS: Record<TaskColumn, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  testing: 'Testing',
  deployed: 'Deployed',
};

const prioritySchema = z.preprocess((val) => {
  if (typeof val === 'string') {
    const v = val.toLowerCase();
    if (v === 'urgent' || v === 'critical' || v === 'p1') return 'P1';
    if (v === 'high' || v === 'p2') return 'P2';
    if (v === 'medium' || v === 'p3') return 'P3';
    if (v === 'low' || v === 'p4') return 'P4';
  }
  return val;
}, z.enum(PRIORITIES));

export const featureChecklistSchema = z.object({
  figma: z.boolean().optional(),
  development: z.boolean().optional(),
  testing: z.boolean().optional(),
  deployed: z.boolean().optional(),
});

export const createTaskSchema = z.object({
  projectId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid project ID').nullable().optional(),
  title: z.string().trim().min(2, 'Title must be at least 2 characters.').max(200),
  description: z.string().trim().max(10000).default(''),
  priority: prioritySchema.default('P3'),
  column: z.enum(TASK_COLUMNS).default('backlog'),
  assigneeId: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
  parentId: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
  ticketId: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  isPersonal: z.boolean().optional(),
  featureChecklist: featureChecklistSchema.optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  description: z.string().trim().max(10000).optional(),
  priority: prioritySchema.optional(),
  column: z.enum(TASK_COLUMNS).optional(),
  position: z.number().optional(),
  assigneeId: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  isPersonal: z.boolean().optional(),
  featureChecklist: featureChecklistSchema.optional(),
});

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const moveTaskSchema = z.object({
  column: z.enum(TASK_COLUMNS),
  position: z.number().int().min(0).default(0),
});

export const PRD_TASK_TYPES = ['feature', 'bug', 'spike', 'refactor', 'technical_debt'] as const;
export type PrdTaskType = (typeof PRD_TASK_TYPES)[number];

export const PRD_RUN_STATUSES = ['draft', 'committed', 'archived', 'discarded'] as const;
export type PrdRunStatus = (typeof PRD_RUN_STATUSES)[number];

export type MoveTaskInput = z.infer<typeof moveTaskSchema>;
