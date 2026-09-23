import { Types } from 'mongoose';
import type { TicketDocument } from '../models/ticket.js';
import { TicketComment } from '../models/ticket-comment.js';
import { writeAudit } from './audit.js';
import type { TicketStatus } from '@/shared';

const VALID_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  new: ['in-progress', 'escalated'],
  'in-progress': ['resolved', 'escalated'],
  resolved: ['closed', 'in-progress'],
  closed: ['in-progress'],
  escalated: ['in-progress', 'resolved'],
};

export async function transitionTicket(
  ticket: TicketDocument,
  targetStatus: TicketStatus,
  actor: { id: string; role: string; kind?: string | null },
  systemNote?: string,
): Promise<TicketDocument> {
  const currentStatus = ticket.status as TicketStatus;

  // Validation
  const allowed = VALID_TRANSITIONS[currentStatus] ?? [];
  if (!allowed.includes(targetStatus)) {
    const err: any = new Error(`Invalid transition from '${currentStatus}' to '${targetStatus}'.`);
    err.code = 'VALIDATION_FAILED';
    err.statusCode = 400;
    throw err;
  }

  // Client vs Staff transition restrictions
  if (targetStatus === 'closed' && actor.kind !== 'client' && actor.role !== 'admin') {
    const err: any = new Error('Only the client can close and rate a resolved ticket.');
    err.code = 'PERMISSION_DENIED';
    err.statusCode = 403;
    throw err;
  }

  ticket.status = targetStatus;
  ticket.lastActivityAt = new Date();

  if (targetStatus === 'resolved') {
    ticket.resolvedAt = new Date();
  } else if (targetStatus === 'closed') {
    ticket.closedAt = new Date();
  }

  await ticket.save();

  // Record system event comment
  if (systemNote) {
    await TicketComment.create({
      ticket: ticket._id,
      author: new Types.ObjectId(actor.id),
      content: systemNote,
      visibility: 'public',
      isSystemEvent: true,
    });
  }

  await writeAudit({
    userId: actor.id,
    action: 'ticket.status_changed',
    resourceType: 'ticket',
    resourceId: ticket._id.toHexString(),
    details: {
      reference: ticket.reference,
      from: currentStatus,
      to: targetStatus,
    },
  });

  return ticket;
}
