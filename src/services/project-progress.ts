import { Types } from 'mongoose';
import { Task } from '../models/task.js';
import { assertProjectAccess, type ScopedUser } from './project-scope.js';
import type { ProjectProgressSummary } from '@/shared';

/**
 * Computes project progress from actual Kanban task states:
 * Completed (column: 'done') vs total tasks.
 * Returns null for percentage if totalTasks is 0.
 */
export async function computeProjectProgress(user: ScopedUser, projectId: string): Promise<ProjectProgressSummary> {
  await assertProjectAccess(user, projectId);

  const projectObjectId = new Types.ObjectId(projectId);
  const tasks = await Task.find({ 
    project: projectObjectId,
    parent: null,
    visibleOnBoard: { $ne: false }
  }).exec();

  const totalTasks = tasks.length;
  let completedTasks = 0;
  let inProgressTasks = 0;
  let backlogTasks = 0;

  for (const t of tasks) {
    if (t.column === 'deployed') {
      completedTasks++;
    } else if (t.column === 'in-progress' || t.column === 'todo' || t.column === 'testing') {
      inProgressTasks++;
    } else {
      backlogTasks++;
    }
  }

  const percentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : null;

  // Build the roadmap view by taking the most recently updated tasks in each category (max 5)
  // Sort tasks by updatedAt descending for the roadmap
  const sortedTasks = [...tasks].sort((a, b) => {
    const dateA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const dateB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return dateB - dateA;
  });

  const inProgressList: any[] = [];
  const upcomingList: any[] = [];
  const completedList: any[] = [];

  for (const t of sortedTasks) {
    const summary = {
      id: t._id.toString(),
      title: t.title,
      priority: t.priority,
      column: t.column,
    };

    if (t.column === 'deployed') {
      completedList.push(summary);
    } else if (t.column === 'in-progress' || t.column === 'todo' || t.column === 'testing') {
      inProgressList.push(summary);
    } else {
      upcomingList.push(summary);
    }
  }

  return {
    projectId,
    totalTasks,
    completedTasks,
    inProgressTasks,
    backlogTasks,
    percentage,
    roadmap: {
      inProgress: inProgressList,
      upcoming: upcomingList,
      completed: completedList,
    },
  };
}
