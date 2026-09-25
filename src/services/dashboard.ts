import { Types } from 'mongoose';
import { Ticket } from '../models/ticket.js';
import { Task } from '../models/task.js';
import { Incident } from '../models/incident.js';
import { Service } from '../models/service.js';
import { AuditLog } from '../models/audit-log.js';
import { assertProjectAccess, type ScopedUser } from './project-scope.js';
import { computeNps, type DashboardQueryInput } from '@/shared';

export interface DashboardData {
  period: string;
  scope: string;
  tickets: {
    total: number;
    open: number;
    resolved: number;
    closed: number;
    byPriority: Record<string, number>;
  };
  tasks: {
    total: number;
    backlog: number;
    todo: number;
    inProgress: number;
    done: number;
    overdue: number;
  };
  operations: {
    totalServices: number;
    servicesUp: number;
    servicesDegraded: number;
    servicesDown: number;
    activeIncidents: number;
    resolvedIncidents: number;
  };
  satisfaction: {
    nps: number | null;
    averageRating: number | null;
    totalResponses: number;
    promoters: number;
    passives: number;
    detractors: number;
    ratingsDistribution: Record<number, number>;
  };
  recentActivity: Array<{
    id: string;
    action: string;
    resourceType: string;
    performedAt: Date;
  }>;
}

export async function getDashboardData(user: ScopedUser, query: DashboardQueryInput): Promise<DashboardData> {
  const periodDays = query.period === '7d' ? 7 : query.period === '90d' ? 90 : 30;
  const periodStart = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

  const filter: any = {};
  if (query.projectId) {
    await assertProjectAccess(user, query.projectId);
    filter.project = new Types.ObjectId(query.projectId);
  } else if (user.kind === 'client') {
    filter.project = { $in: (user.projectIds ?? []).map((id) => new Types.ObjectId(id)) };
  }

  // Aggregation 1: Tickets
  const [ticketStatusCounts, ticketPriorityCounts] = await Promise.all([
    Ticket.aggregate([
      { $match: filter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Ticket.aggregate([
      { $match: { ...filter, status: { $ne: 'closed' } } },
      { $group: { _id: '$priority', count: { $sum: 1 } } },
    ]),
  ]);

  const ticketStatusMap: Record<string, number> = {};
  for (const s of ticketStatusCounts) ticketStatusMap[s._id] = s.count;

  const ticketPriorityMap: Record<string, number> = {};
  for (const p of ticketPriorityCounts) ticketPriorityMap[p._id] = p.count;

  const totalTickets = ticketStatusCounts.reduce((acc, curr) => acc + curr.count, 0);

  // Aggregation 2: Tasks & Overdue
  const now = new Date();
  const taskFilter = { ...filter, parent: null };
  const [taskColCounts, overdueTaskCount] = await Promise.all([
    Task.aggregate([
      { $match: taskFilter },
      { $group: { _id: '$column', count: { $sum: 1 } } },
    ]),
    Task.countDocuments({
      ...taskFilter,
      column: { $ne: 'deployed' },
      dueDate: { $lt: now },
    }).exec(),
  ]);

  const taskColMap: Record<string, number> = {};
  for (const c of taskColCounts) taskColMap[c._id] = c.count;
  const totalTasks = taskColCounts.reduce((acc, curr) => acc + curr.count, 0);

  // Aggregation 3: Services and Incidents
  const [services, activeIncidents, resolvedIncidents] = await Promise.all([
    Service.find(filter).select('lastStatus').lean().exec(),
    Incident.countDocuments({ ...filter, status: 'open' }).exec(),
    Incident.countDocuments({ ...filter, status: 'resolved', resolvedAt: { $gte: periodStart } }).exec(),
  ]);

  let servicesUp = 0;
  let servicesDegraded = 0;
  let servicesDown = 0;
  for (const s of services) {
    if (s.lastStatus === 'up') servicesUp++;
    else if (s.lastStatus === 'degraded') servicesDegraded++;
    else if (s.lastStatus === 'down') servicesDown++;
  }

  // Aggregation 4: Satisfaction and NPS
  const closedTicketsWithFeedback = await Ticket.find({
    ...filter,
    status: 'closed',
    feedbackRating: { $ne: null },
    closedAt: { $gte: periodStart },
  })
    .select('feedbackRating feedbackNps')
    .lean()
    .exec();

  const npsRatings = closedTicketsWithFeedback.map((t) => t.feedbackNps).filter((n): n is number => typeof n === 'number');
  const npsResult = computeNps(npsRatings);

  const starCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let starSum = 0;
  let totalStarCount = 0;

  for (const t of closedTicketsWithFeedback) {
    const rating = t.feedbackRating;
    if (rating && starCounts[rating] !== undefined) {
      starCounts[rating] = (starCounts[rating] ?? 0) + 1;
      starSum += rating;
      totalStarCount++;
    }
  }

  const averageRating = totalStarCount > 0 ? Number((starSum / totalStarCount).toFixed(1)) : null;

  // Aggregation 5: Recent Audit / Operations activity
  const recentLogs = await AuditLog.find({})
    .sort({ createdAt: -1 })
    .limit(8)
    .lean()
    .exec();

  return {
    period: query.period,
    scope: query.scope ?? 'project',
    tickets: {
      total: totalTickets,
      open: (ticketStatusMap['new'] ?? 0) + (ticketStatusMap['in-progress'] ?? 0) + (ticketStatusMap['escalated'] ?? 0),
      resolved: ticketStatusMap['resolved'] ?? 0,
      closed: ticketStatusMap['closed'] ?? 0,
      byPriority: ticketPriorityMap,
    },
    tasks: {
      total: totalTasks,
      backlog: taskColMap['backlog'] ?? 0,
      todo: taskColMap['todo'] ?? 0,
      inProgress: taskColMap['in-progress'] ?? 0,
      done: taskColMap['deployed'] ?? 0,
      overdue: overdueTaskCount,
    },
    operations: {
      totalServices: services.length,
      servicesUp,
      servicesDegraded,
      servicesDown,
      activeIncidents,
      resolvedIncidents,
    },
    satisfaction: {
      nps: npsResult.nps,
      averageRating,
      totalResponses: totalStarCount,
      promoters: npsResult.promoters,
      passives: npsResult.passives,
      detractors: npsResult.detractors,
      ratingsDistribution: starCounts,
    },
    recentActivity: recentLogs.map((log: any) => ({
      id: log._id?.toHexString ? log._id.toHexString() : String(log._id),
      action: log.action,
      resourceType: log.resourceType ?? 'system',
      performedAt: log.timestamp ?? new Date(),
    })),
  };
}
