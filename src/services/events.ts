import { Types } from 'mongoose';
import { ProjectEvent, type ProjectEventDocument } from '../models/project-event.js';
import { assertProjectAccess, type ScopedUser } from './project-scope.js';
import { writeAudit } from './audit.js';
import {
  computeEventUrgency,
  type CreateEventInput,
  type UpdateEventInput,
  type RenewEventInput,
  type EventUrgency,
  type EventStatus,
} from '@/shared';

export interface EventSummaryItem {
  id: string;
  projectId: string;
  projectName?: string;
  type: string;
  title: string;
  description: string;
  date: Date;
  status: EventStatus;
  urgency: EventUrgency;
  responsibleRole: string;
  linkedTicketId: string | null;
  linkedTaskId: string | null;
  predecessorEventId: string | null;
  certificateDetails?: {
    issuer: string;
    domain: string;
    expiryDate: Date | null;
  };
  contractDetails?: {
    parties: string;
    terms: string;
    startDate: Date | null;
    endDate: Date | null;
  };
  maintenanceDetails?: {
    window: string;
    completedWork: string;
    nextScheduled: Date | null;
  };
  createdAt: Date;
}

export function serializeEvent(doc: ProjectEventDocument, windowDays = 30): EventSummaryItem {
  const urgency = computeEventUrgency(doc.date, doc.status as EventStatus, windowDays);
  return {
    id: doc._id.toHexString(),
    projectId: doc.project ? doc.project.toString() : '',
    type: doc.type,
    title: doc.title,
    description: doc.description,
    date: doc.date,
    status: doc.status as EventStatus,
    urgency,
    responsibleRole: doc.responsibleRole,
    linkedTicketId: doc.linkedTicket ? doc.linkedTicket.toString() : null,
    linkedTaskId: doc.linkedTask ? doc.linkedTask.toString() : null,
    predecessorEventId: doc.predecessorEvent ? doc.predecessorEvent.toString() : null,
    certificateDetails: doc.certificateDetails
      ? {
          issuer: doc.certificateDetails.issuer ?? '',
          domain: doc.certificateDetails.domain ?? '',
          expiryDate: doc.certificateDetails.expiryDate ?? null,
        }
      : undefined,
    contractDetails: doc.contractDetails
      ? {
          parties: doc.contractDetails.parties ?? '',
          terms: doc.contractDetails.terms ?? '',
          startDate: doc.contractDetails.startDate ?? null,
          endDate: doc.contractDetails.endDate ?? null,
        }
      : undefined,
    maintenanceDetails: doc.maintenanceDetails
      ? {
          window: doc.maintenanceDetails.window ?? '',
          completedWork: doc.maintenanceDetails.completedWork ?? '',
          nextScheduled: doc.maintenanceDetails.nextScheduled ?? null,
        }
      : undefined,
    createdAt: (doc as any).createdAt ?? new Date(),
  };
}

export async function listEvents(
  user: ScopedUser,
  projectId?: string,
  typeFilter?: string,
): Promise<EventSummaryItem[]> {
  const filter: any = {};
  if (projectId) {
    await assertProjectAccess(user, projectId);
    filter.project = new Types.ObjectId(projectId);
  } else if (user.kind === 'client' && user.role !== 'admin') {
    const projectObjectIds = (user.projectIds ?? []).map((id) =>
      typeof id === 'string' ? new Types.ObjectId(id) : id,
    );
    filter.project = { $in: projectObjectIds };
  }

  if (typeFilter) {
    filter.type = typeFilter;
  }

  const events = await ProjectEvent.find(filter).sort({ date: 1 }).exec();
  return events.map((e) => serializeEvent(e));
}

export async function createEvent(user: ScopedUser, input: CreateEventInput): Promise<EventSummaryItem> {
  const project = await assertProjectAccess(user, input.projectId);

  const event = await ProjectEvent.create({
    project: project._id,
    type: input.type,
    title: input.title,
    description: input.description,
    date: new Date(input.date),
    responsibleRole: input.responsibleRole,
    linkedTicket: input.linkedTicketId ? new Types.ObjectId(input.linkedTicketId) : null,
    linkedTask: input.linkedTaskId ? new Types.ObjectId(input.linkedTaskId) : null,
    certificateDetails: input.certificateDetails
      ? {
          ...input.certificateDetails,
          expiryDate: input.certificateDetails.expiryDate ? new Date(input.certificateDetails.expiryDate) : null,
        }
      : undefined,
    contractDetails: input.contractDetails
      ? {
          ...input.contractDetails,
          startDate: input.contractDetails.startDate ? new Date(input.contractDetails.startDate) : null,
          endDate: input.contractDetails.endDate ? new Date(input.contractDetails.endDate) : null,
        }
      : undefined,
    maintenanceDetails: input.maintenanceDetails
      ? {
          ...input.maintenanceDetails,
          nextScheduled: input.maintenanceDetails.nextScheduled
            ? new Date(input.maintenanceDetails.nextScheduled)
            : null,
        }
      : undefined,
  });

  await writeAudit({
    userId: user.id,
    action: 'event.created',
    resourceType: 'event',
    resourceId: event._id.toHexString(),
    details: { type: input.type, title: input.title },
  });

  return serializeEvent(event);
}

export async function updateEvent(
  user: ScopedUser,
  eventId: string,
  input: UpdateEventInput,
): Promise<EventSummaryItem> {
  const event = await ProjectEvent.findById(eventId).exec();
  if (!event) {
    const error: any = new Error('Event not found');
    error.statusCode = 404;
    throw error;
  }

  await assertProjectAccess(user, event.project.toString());

  if (input.title !== undefined) event.title = input.title;
  if (input.description !== undefined) event.description = input.description;
  if (input.date !== undefined) event.date = new Date(input.date);
  if (input.status !== undefined) event.status = input.status;
  if (input.responsibleRole !== undefined) event.responsibleRole = input.responsibleRole;
  if (input.linkedTicketId !== undefined) {
    event.linkedTicket = input.linkedTicketId ? new Types.ObjectId(input.linkedTicketId) : null;
  }
  if (input.linkedTaskId !== undefined) {
    event.linkedTask = input.linkedTaskId ? new Types.ObjectId(input.linkedTaskId) : null;
  }

  await event.save();

  await writeAudit({
    userId: user.id,
    action: 'event.updated',
    resourceType: 'event',
    resourceId: event._id.toHexString(),
  });

  return serializeEvent(event);
}

export async function renewEvent(
  user: ScopedUser,
  eventId: string,
  input: RenewEventInput,
): Promise<EventSummaryItem> {
  const predecessor = await ProjectEvent.findById(eventId).exec();
  if (!predecessor) {
    const error: any = new Error('Event not found');
    error.statusCode = 404;
    throw error;
  }

  await assertProjectAccess(user, predecessor.project.toString());

  // Mark predecessor completed
  predecessor.status = 'completed';
  await predecessor.save();

  // Create renewed successor event
  const successor = await ProjectEvent.create({
    project: predecessor.project,
    type: predecessor.type,
    title: `${predecessor.title} (Renewed)`,
    description: input.description ?? `Renewed from event ${predecessor._id.toHexString()}`,
    date: new Date(input.newDate),
    status: 'scheduled',
    responsibleRole: predecessor.responsibleRole,
    predecessorEvent: predecessor._id,
    certificateDetails: predecessor.certificateDetails,
    contractDetails: predecessor.contractDetails,
    maintenanceDetails: predecessor.maintenanceDetails,
  });

  await writeAudit({
    userId: user.id,
    action: 'event.renewed',
    resourceType: 'event',
    resourceId: successor._id.toHexString(),
    details: { predecessorId: predecessor._id.toHexString() },
  });

  return serializeEvent(successor);
}
