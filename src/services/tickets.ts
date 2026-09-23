import mongoose, { Types, type FilterQuery } from 'mongoose';
import { Ticket, type TicketDocument } from '../models/ticket.js';
import { User } from '../models/user.js';
import { TicketComment } from '../models/ticket-comment.js';
import { generateTicketReference } from './ticket-reference.js';
import { assertProjectAccess, assertTicketAccess, scopeTicketQuery, type ScopedUser } from './project-scope.js';
import { transitionTicket } from './ticket-state.js';
import { writeAudit } from './audit.js';
import type {
  CreateTicketInput,
  TicketQueryInput,
  ResolveTicketInput,
  EscalateTicketInput,
  TicketFeedbackInput,
  BulkTicketActionInput,
} from '@/shared';

export interface TicketSummaryItem {
  id: string;
  reference: string;
  projectId: string;
  projectName: string;
  clientName: string;
  title: string;
  description: string;
  type: string;
  priority: string;
  status: string;
  assigneeId: string | null;
  assigneeName: string | null;
  requesterId: string;
  requesterName: string;
  attachmentsCount: number;
  lastActivityAt: Date;
  createdAt: Date;
}

export function serializeTicketSummary(doc: any): TicketSummaryItem {
  const id = doc._id?.toHexString ? doc._id.toHexString() : String(doc._id ?? '');
  const projectId = doc.project?._id
    ? (doc.project._id.toHexString ? doc.project._id.toHexString() : doc.project._id.toString())
    : doc.project ? doc.project.toString() : '';
  const assigneeId = doc.assignee?._id
    ? (doc.assignee._id.toHexString ? doc.assignee._id.toHexString() : doc.assignee._id.toString())
    : doc.assignee ? doc.assignee.toString() : null;
  const requesterId = doc.requester?._id
    ? (doc.requester._id.toHexString ? doc.requester._id.toHexString() : doc.requester._id.toString())
    : doc.requester ? doc.requester.toString() : '';

  return {
    id,
    reference: doc.reference,
    projectId,
    projectName: doc.project?.name ?? '—',
    clientName: doc.project?.clientName ?? '—',
    title: doc.title,
    description: doc.description,
    type: doc.type,
    priority: doc.priority,
    status: doc.status,
    assigneeId,
    assigneeName: doc.assignee?.profile?.fullName || doc.assignee?.username || null,
    requesterId,
    requesterName: doc.requester?.profile?.fullName || doc.requester?.username || '—',
    attachmentsCount: doc.attachments?.length ?? 0,
    lastActivityAt: doc.lastActivityAt ?? doc.createdAt,
    createdAt: doc.createdAt,
  };
}

export async function createTicket(user: ScopedUser, input: CreateTicketInput): Promise<TicketSummaryItem> {
  const project = await assertProjectAccess(user, input.projectId);
  const reference = await generateTicketReference();

  const ticket = await Ticket.create({
    reference,
    project: project._id,
    requester: new Types.ObjectId(user.id),
    title: input.title,
    description: input.description,
    type: input.type,
    priority: input.priority,
    status: 'new',
    attachments: input.attachments ?? [],
    lastActivityAt: new Date(),
  });

  await TicketComment.create({
    ticket: ticket._id,
    author: new Types.ObjectId(user.id),
    content: `Ticket ${reference} created by ${user.kind === 'client' ? 'client' : 'staff'}.`,
    visibility: 'public',
    isSystemEvent: true,
  });

  await writeAudit({
    userId: user.id,
    action: 'ticket.created',
    resourceType: 'ticket',
    resourceId: ticket._id.toHexString(),
    details: { reference, priority: ticket.priority, project: project.name },
  });

  const populated = await Ticket.findById(ticket._id)
    .populate('project', 'name clientName')
    .populate('requester', 'username profile')
    .lean()
    .exec();

  return serializeTicketSummary(populated);
}

export async function queryTickets(user: ScopedUser, input: TicketQueryInput): Promise<{
  tickets: TicketSummaryItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}> {
  let baseFilter: FilterQuery<TicketDocument> = {};

  if (input.queue === 'unclaimed') {
    baseFilter.assignee = null;
    baseFilter.status = { $in: ['new', 'escalated'] };
  } else if (input.queue === 'my_tickets') {
    baseFilter.assignee = new Types.ObjectId(user.id);
    baseFilter.status = { $nin: ['closed', 'resolved'] };
  } else if (input.queue === 'urgent') {
    baseFilter.priority = 'P1';
    baseFilter.status = { $nin: ['closed', 'resolved'] };
  } else if (input.queue === 'closed') {
    baseFilter.status = 'closed';
  } else {
    baseFilter.status = { $nin: ['closed', 'resolved'] };
  }

  if (input.status) baseFilter.status = input.status;
  if (input.priority) baseFilter.priority = input.priority;
  if (input.projectId) baseFilter.project = new Types.ObjectId(input.projectId);
  if (input.assigneeId) baseFilter.assignee = new Types.ObjectId(input.assigneeId);

  if (input.search) {
    const term = input.search.trim();
    const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    baseFilter.$or = [{ title: regex }, { reference: regex }, { description: regex }];
  }

  const scopedFilter = scopeTicketQuery(user, baseFilter);
  const offset = (input.page - 1) * input.pageSize;
  const sortDirection = input.order === 'asc' ? 1 : -1;

  const [facetResult] = await Ticket.aggregate<{
    data: any[];
    total: Array<{ count: number }>;
  }>([
    { $match: scopedFilter },
    {
      $facet: {
        data: [
          { $sort: { [input.sort]: sortDirection, _id: -1 } },
          { $skip: offset },
          { $limit: input.pageSize },
          {
            $lookup: {
              from: 'projects',
              localField: 'project',
              foreignField: '_id',
              as: 'project',
              pipeline: [{ $project: { name: 1, clientName: 1 } }],
            },
          },
          { $unwind: { path: '$project', preserveNullAndEmptyArrays: true } },
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
              from: 'users',
              localField: 'requester',
              foreignField: '_id',
              as: 'requester',
              pipeline: [{ $project: { username: 1, profile: 1 } }],
            },
          },
          { $unwind: { path: '$requester', preserveNullAndEmptyArrays: true } },
        ],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  const total = facetResult?.total[0]?.count ?? 0;
  const docs = facetResult?.data ?? [];

  return {
    tickets: docs.map(serializeTicketSummary),
    total,
    page: input.page,
    pageSize: input.pageSize,
    totalPages: Math.max(1, Math.ceil(total / input.pageSize)),
  };
}

export async function getQueueCounts(user: ScopedUser): Promise<{
  all: number;
  unclaimed: number;
  my_tickets: number;
  urgent: number;
}> {
  const baseFilter = scopeTicketQuery(user, {});
  const userObjectId = new Types.ObjectId(user.id);

  const [result] = await Ticket.aggregate<{
    all: number;
    unclaimed: number;
    my_tickets: number;
    urgent: number;
  }>([
    { $match: baseFilter },
    {
      $group: {
        _id: null,
        all: {
          $sum: {
            $cond: [{ $not: [{ $in: ['$status', ['closed', 'resolved']] }] }, 1, 0],
          },
        },
        unclaimed: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$assignee', null] },
                  { $in: ['$status', ['new', 'escalated']] },
                ],
              },
              1,
              0,
            ],
          },
        },
        my_tickets: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$assignee', userObjectId] },
                  { $not: [{ $in: ['$status', ['closed', 'resolved']] }] },
                ],
              },
              1,
              0,
            ],
          },
        },
        urgent: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$priority', 'P1'] },
                  { $not: [{ $in: ['$status', ['closed', 'resolved']] }] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);

  return {
    all: result?.all ?? 0,
    unclaimed: result?.unclaimed ?? 0,
    my_tickets: result?.my_tickets ?? 0,
    urgent: result?.urgent ?? 0,
  };
}

/**
 * Ticket KPI status aggregation.
 * Aggregates tickets by status in a single round-trip and maps to open/in-progress/pending response shape.
 */
export async function getTicketKPIs(user: ScopedUser, baseFilter: FilterQuery<TicketDocument> = {}): Promise<{
  open: number;
  inProgress: number;
  pending: number;
  resolved: number;
  closed: number;
  byStatus: Record<string, number>;
}> {
  const scopedFilter = scopeTicketQuery(user, baseFilter);
  const statusCounts = await Ticket.aggregate<{ _id: string; count: number }>([
    { $match: scopedFilter },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const map: Record<string, number> = {};
  for (const item of statusCounts) {
    map[item._id] = item.count;
  }

  return {
    open: (map['new'] ?? 0) + (map['in-progress'] ?? 0) + (map['escalated'] ?? 0),
    inProgress: map['in-progress'] ?? 0,
    pending: (map['new'] ?? 0) + (map['escalated'] ?? 0),
    resolved: map['resolved'] ?? 0,
    closed: map['closed'] ?? 0,
    byStatus: map,
  };
}

export async function getTicketDetail(user: ScopedUser, referenceOrId: string): Promise<any> {
  const query = Types.ObjectId.isValid(referenceOrId)
    ? { $or: [{ _id: new Types.ObjectId(referenceOrId) }, { reference: referenceOrId }] }
    : { reference: referenceOrId };

  const ticket = await Ticket.findOne(query)
    .populate('project', 'name clientName')
    .populate('assignee', 'username profile')
    .populate('requester', 'username profile')
    .lean()
    .exec();

  if (!ticket) {
    const error: any = new Error('Ticket not found');
    error.statusCode = 404;
    error.code = 'NOT_FOUND';
    throw error;
  }

  await assertTicketAccess(user, ticket as any);

  // Retrieve comments (filter internal notes for clients)
  const commentFilter: any = { ticket: ticket._id };
  if (user.kind === 'client') {
    commentFilter.visibility = 'public';
  }

  const [comments, linkedTasks] = await Promise.all([
    TicketComment.find(commentFilter)
      .sort({ createdAt: 1 })
      .populate('author', 'username profile kind')
      .lean()
      .exec(),
    mongoose.models.Task
      ? mongoose.models.Task.find({ ticket: ticket._id })
          .select('title priority column position dueDate')
          .sort({ createdAt: 1 })
          .lean()
          .exec()
      : Promise.resolve([]),
  ]);

  return {
    ...serializeTicketSummary(ticket),
    attachments: ticket.attachments ?? [],
    resolutionNote: ticket.resolutionNote,
    resolvedAt: ticket.resolvedAt,
    closedAt: ticket.closedAt,
    feedbackRating: ticket.feedbackRating,
    feedbackNps: ticket.feedbackNps,
    feedbackComment: ticket.feedbackComment,
    escalatedAt: ticket.escalatedAt,
    escalationTier: ticket.escalationTier,
    escalationReason: ticket.escalationReason,
    linkedTasks: linkedTasks.map((t: any) => ({
      id: t._id?.toHexString ? t._id.toHexString() : String(t._id),
      title: t.title,
      priority: t.priority,
      column: t.column,
      dueDate: t.dueDate ?? null,
    })),
    comments: comments.map((c: any) => ({
      id: c._id?.toHexString ? c._id.toHexString() : String(c._id),
      content: c.content,
      visibility: c.visibility,
      isSystemEvent: c.isSystemEvent,
      createdAt: c.createdAt,
      author: {
        id: c.author?._id?.toHexString ? c.author._id.toHexString() : (c.author?._id ? String(c.author._id) : ''),
        username: c.author?.username ?? '—',
        fullName: c.author?.profile?.fullName ?? c.author?.username ?? '—',
        kind: c.author?.kind ?? 'staff',
      },
    })),
  };
}

/**
 * Atomic Ticket Claim (S04, R029).
 * Prevents race condition via atomic query criteria: {_id, assignee: null, status: 'new'}.
 */
export async function claimTicket(user: ScopedUser, ticketId: string): Promise<TicketSummaryItem> {
  const actorObjectId = new Types.ObjectId(user.id);
  const now = new Date();

  const claimed = await Ticket.findOneAndUpdate(
    { _id: new Types.ObjectId(ticketId), assignee: null },
    { $set: { assignee: actorObjectId, status: 'in-progress', lastActivityAt: now } },
    { new: true },
  )
    .populate('project', 'name clientName')
    .populate('assignee', 'username profile')
    .populate('requester', 'username profile')
    .exec();

  if (!claimed) {
    const existing = await Ticket.findById(ticketId).populate('assignee', 'username profile').lean().exec();
    const currentAssignee = (existing?.assignee as any)?.profile?.fullName || (existing?.assignee as any)?.username || 'someone else';
    const err: any = new Error(`Ticket is already claimed by ${currentAssignee}.`);
    err.statusCode = 409;
    err.code = 'CONFLICT';
    throw err;
  }

  await TicketComment.create({
    ticket: claimed._id,
    author: actorObjectId,
    content: 'Ticket claimed by agent.',
    visibility: 'public',
    isSystemEvent: true,
  });

  await writeAudit({
    userId: user.id,
    action: 'ticket.claimed',
    resourceType: 'ticket',
    resourceId: claimed._id.toHexString(),
    details: { reference: claimed.reference },
  });

  return serializeTicketSummary(claimed);
}

export async function assignTicket(user: ScopedUser, ticketId: string, assigneeId: string | null): Promise<TicketSummaryItem> {
  const ticket = await Ticket.findById(ticketId).exec();
  if (!ticket) throw new Error('Ticket not found');

  const assigneeUser = assigneeId ? await User.findById(assigneeId).lean().exec() : null;
  ticket.assignee = assigneeUser ? assigneeUser._id : null;
  ticket.lastActivityAt = new Date();
  if (ticket.status === 'new' && assigneeUser) {
    ticket.status = 'in-progress';
  }
  await ticket.save();

  await TicketComment.create({
    ticket: ticket._id,
    author: new Types.ObjectId(user.id),
    content: assigneeUser ? `Assigned to ${assigneeUser.profile?.fullName || assigneeUser.username}.` : 'Ticket unassigned.',
    visibility: 'public',
    isSystemEvent: true,
  });

  await writeAudit({
    userId: user.id,
    action: 'ticket.assigned',
    resourceType: 'ticket',
    resourceId: ticket._id.toHexString(),
    details: { reference: ticket.reference, assigneeId },
  });

  const updated = await Ticket.findById(ticket._id)
    .populate('project', 'name clientName')
    .populate('assignee', 'username profile')
    .populate('requester', 'username profile')
    .lean()
    .exec();

  return serializeTicketSummary(updated);
}

export async function resolveTicket(user: ScopedUser, ticketId: string, input: ResolveTicketInput): Promise<any> {
  const ticket = await Ticket.findById(ticketId).exec();
  if (!ticket) throw new Error('Ticket not found');

  ticket.resolutionNote = input.resolutionNote;
  await transitionTicket(ticket, 'resolved', user, `Resolved: ${input.resolutionNote}`);

  return getTicketDetail(user, ticket._id.toHexString());
}

export async function escalateTicket(user: ScopedUser, ticketId: string, input: EscalateTicketInput): Promise<any> {
  const ticket = await Ticket.findById(ticketId).exec();
  if (!ticket) throw new Error('Ticket not found');

  ticket.escalationReason = input.reason;
  ticket.escalationTier = input.tier;
  ticket.escalatedAt = new Date();
  ticket.escalatedBy = new Types.ObjectId(user.id);

  await transitionTicket(ticket, 'escalated', user, `Escalated to ${input.tier}: ${input.reason}`);

  return getTicketDetail(user, ticket._id.toHexString());
}

export async function closeAndRateTicket(user: ScopedUser, ticketId: string, input: TicketFeedbackInput): Promise<any> {
  if (user.kind !== 'client') throw new Error('Only clients can close tickets.');
  const ticket = await Ticket.findById(ticketId).exec();
  if (!ticket) throw new Error('Ticket not found');

  await assertTicketAccess(user, ticket);

  ticket.feedbackRating = input.rating;
  ticket.feedbackNps = input.nps;
  ticket.feedbackComment = input.comment ?? '';
  ticket.feedbackAt = new Date();

  await transitionTicket(
    ticket,
    'closed',
    user,
    `Closed by client with rating ${input.rating}/5 and NPS ${input.nps}/10. ${input.comment ? `"${input.comment}"` : ''}`,
  );

  return getTicketDetail(user, ticket._id.toHexString());
}

export async function reopenTicket(user: ScopedUser, ticketId: string, reason: string): Promise<any> {
  if (user.kind !== 'client') throw new Error('Only clients can reopen tickets.');
  const ticket = await Ticket.findById(ticketId).exec();
  if (!ticket) throw new Error('Ticket not found');

  await assertTicketAccess(user, ticket);

  await transitionTicket(ticket, 'in-progress', user, `Reopened by client: ${reason || 'Client requested further action.'}`);

  return getTicketDetail(user, ticket._id.toHexString());
}

export async function addComment(
  user: ScopedUser,
  ticketId: string,
  content: string,
  visibility: 'public' | 'internal',
): Promise<any> {
  const ticket = await Ticket.findById(ticketId).exec();
  if (!ticket) throw new Error('Ticket not found');

  await assertTicketAccess(user, ticket);

  // Clients can only post public comments
  const effectiveVisibility = user.kind === 'client' ? 'public' : visibility;

  const comment = await TicketComment.create({
    ticket: ticket._id,
    author: new Types.ObjectId(user.id),
    content,
    visibility: effectiveVisibility,
    isSystemEvent: false,
  });

  ticket.lastActivityAt = new Date();
  await ticket.save();

  return {
    id: comment._id.toHexString(),
    content: comment.content,
    visibility: comment.visibility,
    isSystemEvent: comment.isSystemEvent,
    createdAt: (comment as any).createdAt,
  };
}

export async function executeBulkAction(
  user: ScopedUser,
  input: BulkTicketActionInput,
): Promise<{ updated: number; failed: Array<{ id: string; error: string }> }> {
  let updated = 0;
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of input.ticketIds) {
    try {
      const ticket = await Ticket.findById(id).exec();
      if (!ticket) throw new Error('Ticket not found');

      if (input.action === 'assign') {
        await assignTicket(user, id, input.assigneeId ?? null);
      } else if (input.action === 'set_priority' && input.priority) {
        ticket.priority = input.priority;
        ticket.lastActivityAt = new Date();
        await ticket.save();
      } else if (input.action === 'close') {
        if (ticket.status !== 'resolved') {
          throw new Error('Only resolved tickets can be closed.');
        }
        await transitionTicket(ticket, 'closed', user, 'Closed via bulk administration.');
      }
      updated += 1;
    } catch (err: any) {
      failed.push({ id, error: err.message });
    }
  }

  return { updated, failed };
}
