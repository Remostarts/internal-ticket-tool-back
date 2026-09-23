import { Types, type FilterQuery } from 'mongoose';
import { Project, type ProjectDocument } from '../models/project.js';
import type { TicketDocument } from '../models/ticket.js';
import { AppError } from '../middleware/error-handler.js';

export interface ScopedUser {
  id: string;
  role: string;
  kind?: string | null;
  clientId?: string | null;
  projectIds?: Array<Types.ObjectId | string> | null;
}

/**
 * Ensures user has access to the specified project.
 * If user is a client, project must match their assigned projectIds.
 * Throws 404 NOT_FOUND so tenant existence is not leaked across boundaries (R024).
 */
export async function assertProjectAccess(user: ScopedUser, projectId: string | Types.ObjectId): Promise<ProjectDocument> {
  const projectObjectId = typeof projectId === 'string' ? new Types.ObjectId(projectId) : projectId;

  const project = await Project.findById(projectObjectId).exec();
  if (!project) {
    throw new AppError('NOT_FOUND', 'Project not found');
  }

  if (user.role === 'admin' || user.kind !== 'client') {
    return project;
  }

  // Client user check
  const assigned = (user.projectIds ?? []).map((id) => id.toString());
  if (!assigned.includes(projectObjectId.toHexString())) {
    const error: any = new Error('Project not found');
    error.statusCode = 404;
    error.code = 'NOT_FOUND';
    throw error;
  }

  return project;
}

/**
 * Scopes a MongoDB query for tickets based on caller permissions and tenant boundary.
 */
export function scopeTicketQuery(user: ScopedUser, baseFilter: FilterQuery<TicketDocument> = {}): FilterQuery<TicketDocument> {
  const filter: FilterQuery<TicketDocument> = { ...baseFilter };

  if (user.role === 'admin') {
    return filter;
  }

  if (user.kind === 'client') {
    const projectObjectIds = (user.projectIds ?? []).map((id) =>
      typeof id === 'string' ? new Types.ObjectId(id) : id,
    );
    filter.project = { $in: projectObjectIds };
    filter.requester = new Types.ObjectId(user.id);
    return filter;
  }

  return filter;
}

/**
 * Asserts user access to a specific ticket.
 */
export async function assertTicketAccess(user: ScopedUser, ticket: TicketDocument): Promise<void> {
  if (user.role === 'admin') return;

  if (user.kind === 'client') {
    const assigned = (user.projectIds ?? []).map((id) => id.toString());
    const ticketProjectId = (ticket.project as any)?._id
      ? (ticket.project as any)._id.toString()
      : ticket.project
        ? ticket.project.toString()
        : '';
    const ticketRequesterId = (ticket.requester as any)?._id
      ? (ticket.requester as any)._id.toString()
      : ticket.requester
        ? ticket.requester.toString()
        : '';

    if (!assigned.includes(ticketProjectId) || ticketRequesterId !== user.id) {
      throw new AppError('NOT_FOUND', 'Ticket not found');
    }
  }
}
