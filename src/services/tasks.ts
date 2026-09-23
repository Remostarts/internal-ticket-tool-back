import { Types } from 'mongoose';
import { Task } from '../models/task.js';
import { assertProjectAccess, type ScopedUser } from './project-scope.js';
import { writeAudit } from './audit.js';
import type { CreateTaskInput, MoveTaskInput, TaskColumn } from '@/shared';

export interface TaskSummary {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: string;
  column: TaskColumn;
  position: number;
  assigneeId: string | null;
  assigneeName: string | null;
  creatorId: string;
  parentId: string | null;
  ticketId: string | null;
  subtaskCount: number;
  completedSubtaskCount: number;
  dueDate: Date | null;
  createdAt: Date;
  // PRD fields
  isRiskSpike: boolean;
  blockedByIds: string[];
  acceptanceCriteria: Array<{ text: string; done: boolean }>;
  type: string | null;
  isPersonal?: boolean;
}

export function serializeTask(doc: any, subtaskCount = 0, completedSubtaskCount = 0): TaskSummary {
  const id = doc._id?.toHexString ? doc._id.toHexString() : String(doc._id ?? '');
  return {
    id,
    projectId: doc.project?.toString() ?? '',
    title: doc.title,
    description: doc.description ?? '',
    priority: doc.priority,
    column: doc.column,
    position: doc.position ?? 0,
    assigneeId: doc.assignee?._id ? (doc.assignee._id.toHexString ? doc.assignee._id.toHexString() : doc.assignee._id.toString()) : doc.assignee?.toString() ?? null,
    assigneeName: doc.assignee?.profile?.fullName || doc.assignee?.username || null,
    creatorId: doc.creator?.toString() ?? '',
    parentId: doc.parent?.toString() ?? null,
    ticketId: doc.ticket?.toString() ?? null,
    subtaskCount,
    completedSubtaskCount,
    dueDate: doc.dueDate ?? null,
    createdAt: doc.createdAt,
    isRiskSpike: doc.isRiskSpike ?? false,
    blockedByIds: (doc.blockedByIds ?? []).map((id: any) => id.toString()),
    acceptanceCriteria: doc.acceptanceCriteria ?? [],
    type: doc.type ?? null,
    isPersonal: doc.isPersonal ?? false,
  };
}

export async function getTaskById(user: ScopedUser, taskId: string): Promise<TaskSummary> {
  const task = await Task.findById(taskId).populate('assignee');
  if (!task) throw new Error('Task not found');
  if (task.project) {
    await assertProjectAccess(user, task.project.toString());
  }

  const subtasks = await Task.find({ parent: task._id });
  const completedSubtasks = subtasks.filter(st => st.column === 'deployed').length;
  
  return serializeTask(task, subtasks.length, completedSubtasks);
}

export async function getProjectBoard(
  user: ScopedUser,
  projectId: string,
  options: { personalOnly?: boolean; userId?: string } = {},
): Promise<Record<TaskColumn, TaskSummary[]>> {
  const query: any = { parent: null, visibleOnBoard: { $ne: false } };

  if (projectId === 'personal' || options.personalOnly) {
    const targetUserId = options.userId || user.id;
    query.assignee = new Types.ObjectId(targetUserId);
    if (user.kind === 'client') {
      query.project = { $in: user.projectIds ?? [] };
    }
  } else {
    await assertProjectAccess(user, projectId);
    query.project = new Types.ObjectId(projectId);
    // CRITICAL: Personal tasks must NOT appear on other team/project Kanban boards
    query.isPersonal = { $ne: true };
    if (options.userId) {
      query.assignee = new Types.ObjectId(options.userId);
    }
  }

  const tasks = await Task.aggregate<any>([
    { $match: query },
    { $sort: { column: 1, position: 1, createdAt: 1 } },
    {
      $lookup: {
        from: 'users',
        localField: 'assignee',
        foreignField: '_id',
        as: 'assignee',
        pipeline: [{ $project: { username: 1, profile: 1 } }],
      },
    },
    { $unwind: { path: '$assignee', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'tasks',
        let: { parentId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$parent', '$$parentId'] } } },
          {
            $group: {
              _id: '$parent',
              count: { $sum: 1 },
              completedCount: {
                $sum: { $cond: [{ $eq: ['$column', 'deployed'] }, 1, 0] },
              },
            },
          },
        ],
        as: 'subtaskStats',
      },
    },
    {
      $addFields: {
        subtaskStats: { $arrayElemAt: ['$subtaskStats', 0] },
      },
    },
  ]);

  const board: Record<TaskColumn, TaskSummary[]> = {
    backlog: [],
    todo: [],
    'in-progress': [],
    testing: [],
    deployed: [],
  };

  for (const t of tasks) {
    const col = t.column as TaskColumn;
    if (board[col]) {
      board[col].push(serializeTask(t, t.subtaskStats?.count ?? 0, t.subtaskStats?.completedCount ?? 0));
    }
  }

  return board;
}

export async function getTaskSubtasks(user: ScopedUser, taskId: string): Promise<TaskSummary[]> {
  const task = await Task.findById(taskId).lean().exec();
  if (!task) return [];
  
  if (task.project) {
    await assertProjectAccess(user, task.project.toString());
  }

  const subtasks = await Task.find({ parent: new Types.ObjectId(taskId) })
    .sort({ createdAt: 1 })
    .populate('assignee', 'username profile')
    .lean()
    .exec();

  return subtasks.map(t => serializeTask(t, 0));
}

export async function createTask(user: ScopedUser, input: CreateTaskInput): Promise<TaskSummary> {
  const projectObjId = input.projectId ? new Types.ObjectId(input.projectId) : null;
  if (projectObjId) {
    await assertProjectAccess(user, input.projectId!);
  }

  const countQuery: any = { column: input.column };
  if (projectObjId) {
    countQuery.project = projectObjId;
  } else {
    countQuery.project = null;
    countQuery.creator = new Types.ObjectId(user.id);
  }

  const count = await Task.countDocuments(countQuery).exec();
  const isPersonalTask = input.isPersonal === true || !projectObjId;

  const task = await Task.create({
    project: projectObjId,
    title: input.title,
    description: input.description,
    priority: input.priority,
    column: input.column,
    position: count,
    assignee: input.assigneeId ? new Types.ObjectId(input.assigneeId) : new Types.ObjectId(user.id),
    creator: new Types.ObjectId(user.id),
    parent: input.parentId ? new Types.ObjectId(input.parentId) : null,
    ticket: input.ticketId ? new Types.ObjectId(input.ticketId) : null,
    dueDate: input.dueDate ? new Date(input.dueDate) : null,
    isPersonal: isPersonalTask,
  });

  await writeAudit({
    userId: user.id,
    action: 'task.created',
    resourceType: 'task',
    resourceId: task._id.toHexString(),
    details: { title: task.title, project: input.projectId ?? 'personal', column: task.column },
  });

  const populated = await Task.findById(task._id).populate('assignee', 'username profile').lean().exec();
  return serializeTask(populated);
}

export async function moveTask(user: ScopedUser, taskId: string, input: MoveTaskInput): Promise<TaskSummary> {
  const task = await Task.findById(taskId).exec();
  if (!task) throw new Error('Task not found');

  if (task.project) {
    await assertProjectAccess(user, task.project.toString());
  } else {
    // Standalone personal task: caller must be assignee or creator, or admin
    if (
      user.role !== 'admin' &&
      task.creator.toString() !== user.id &&
      task.assignee?.toString() !== user.id
    ) {
      throw new Error('You do not have permission to move this task');
    }
  }

  task.column = input.column;
  task.position = input.position;
  await task.save();

  await writeAudit({
    userId: user.id,
    action: 'task.moved',
    resourceType: 'task',
    resourceId: task._id.toHexString(),
    details: { toColumn: input.column, position: input.position },
  });

  const populated = await Task.findById(task._id).populate('assignee', 'username profile').lean().exec();
  return serializeTask(populated);
}

export async function deleteTask(user: ScopedUser, taskId: string): Promise<void> {
  const task = await Task.findById(taskId).lean().exec();
  if (!task) throw new Error('Task not found');

  if (task.project) {
    await assertProjectAccess(user, task.project.toString());
  } else {
    // Standalone personal task: caller must be assignee or creator, or admin
    if (
      user.role !== 'admin' &&
      task.creator.toString() !== user.id &&
      task.assignee?.toString() !== user.id
    ) {
      throw new Error('You do not have permission to delete this task');
    }
  }

  // Delete all subtasks first
  await Task.deleteMany({ parent: new Types.ObjectId(taskId) }).exec();
  
  // Delete the task itself
  await Task.findByIdAndDelete(taskId).exec();

  await writeAudit({
    userId: user.id,
    action: 'task.deleted',
    resourceType: 'task',
    resourceId: (task as any)._id?.toHexString ? (task as any)._id.toHexString() : String((task as any)._id),
    details: { title: task.title, project: task.project?.toString() ?? 'personal' },
  });
}

/**
 * Watchtower attention view aggregation (M004, R048).
 * Finds overdue tasks, tasks due today, and priority distribution across projects.
 */
export async function getWatchtowerData(user: ScopedUser, projectId?: string | null): Promise<any> {
  const filter: any = {};
  if (projectId) {
    filter.project = new Types.ObjectId(projectId);
  } else if (user.kind === 'client') {
    filter.project = { $in: user.projectIds ?? [] };
  }

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const [overdueTasks, dueTodayTasks, loadByPriority] = await Promise.all([
    Task.find({
      ...filter,
      column: { $ne: 'done' },
      dueDate: { $lt: startOfDay },
    })
      .populate('project', 'name')
      .populate('assignee', 'username profile')
      .limit(50)
      .lean()
      .exec(),

    Task.find({
      ...filter,
      column: { $ne: 'done' },
      dueDate: { $gte: startOfDay, $lte: endOfDay },
    })
      .populate('project', 'name')
      .populate('assignee', 'username profile')
      .limit(50)
      .lean()
      .exec(),

    Task.aggregate([
      { $match: { ...filter, column: { $ne: 'done' } } },
      { $group: { _id: '$priority', count: { $sum: 1 } } },
    ]),
  ]);

  return {
    overdue: overdueTasks.map((t) => serializeTask(t)),
    dueToday: dueTodayTasks.map((t) => serializeTask(t)),
    loadByPriority: Object.fromEntries(loadByPriority.map((row) => [row._id, row.count])),
  };
}
