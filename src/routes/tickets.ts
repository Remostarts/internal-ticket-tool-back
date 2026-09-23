import { Router } from 'express';
import {
  createTicketSchema,
  ticketQuerySchema,
  resolveTicketSchema,
  escalateTicketSchema,
  assignTicketSchema,
  addCommentSchema,
  ticketFeedbackSchema,
  bulkTicketActionSchema,
} from '@/shared';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePermission } from '../middleware/require-permission.js';
import {
  createTicket,
  queryTickets,
  getQueueCounts,
  getTicketDetail,
  claimTicket,
  assignTicket,
  resolveTicket,
  escalateTicket,
  closeAndRateTicket,
  reopenTicket,
  addComment,
  executeBulkAction,
} from '../services/tickets.js';
import { sendNotification } from '../services/notify.js';

export function createTicketsRouter(): Router {
  const router = Router();

  // Create Ticket (Client / Staff)
  router.post(
    '/api/tickets',
    requireAuth,
    requirePermission('tickets:create'),
    asyncHandler(async (req, res) => {
      const input = createTicketSchema.parse(req.body);
      const ticket = await createTicket(req.sessionUser as any, input);

      void sendNotification({
        type: 'ticketCreated',
        reference: ticket.reference,
        summary: ticket.title,
      });

      res.status(201).json(ticket);
    }),
  );

  // List / Query Tickets
  router.get(
    '/api/tickets',
    requireAuth,
    requirePermission('tickets:read'),
    asyncHandler(async (req, res) => {
      const query = ticketQuerySchema.parse(req.query);
      const result = await queryTickets(req.sessionUser as any, query);
      res.status(200).json(result);
    }),
  );

  // Queue Counts endpoint for Console rail
  router.get(
    '/api/tickets/queue-counts',
    requireAuth,
    requirePermission('tickets:read'),
    asyncHandler(async (req, res) => {
      const counts = await getQueueCounts(req.sessionUser as any);
      res.status(200).json(counts);
    }),
  );

  // Bulk Ticket Action
  router.post(
    '/api/tickets/bulk',
    requireAuth,
    requirePermission('tickets:assign'),
    asyncHandler(async (req, res) => {
      const input = bulkTicketActionSchema.parse(req.body);
      const result = await executeBulkAction(req.sessionUser as any, input);
      res.status(200).json(result);
    }),
  );

  // Get Single Ticket Detail
  router.get(
    '/api/tickets/:referenceOrId',
    requireAuth,
    requirePermission('tickets:read'),
    asyncHandler(async (req, res) => {
      const ticket = await getTicketDetail(req.sessionUser as any, req.params.referenceOrId as string);
      res.status(200).json(ticket);
    }),
  );

  // Atomic Claim Ticket (Staff)
  router.post(
    '/api/tickets/:id/claim',
    requireAuth,
    requirePermission('tickets:claim'),
    asyncHandler(async (req, res) => {
      const claimed = await claimTicket(req.sessionUser as any, req.params.id as string);

      void sendNotification({
        type: 'ticketClaimed',
        reference: claimed.reference,
        summary: `Claimed by ${req.sessionUser?.username}`,
      });

      res.status(200).json(claimed);
    }),
  );

  // Assign Ticket (Staff / Manager)
  router.post(
    '/api/tickets/:id/assign',
    requireAuth,
    requirePermission('tickets:assign'),
    asyncHandler(async (req, res) => {
      const input = assignTicketSchema.parse(req.body);
      const assigned = await assignTicket(req.sessionUser as any, req.params.id as string, input.assigneeId);
      res.status(200).json(assigned);
    }),
  );

  // Resolve Ticket with Mandatory Note
  router.post(
    '/api/tickets/:id/resolve',
    requireAuth,
    requirePermission('tickets:resolve'),
    asyncHandler(async (req, res) => {
      const input = resolveTicketSchema.parse(req.body);
      const resolved = await resolveTicket(req.sessionUser as any, req.params.id as string, input);

      void sendNotification({
        type: 'ticketResolved',
        reference: resolved.reference,
        summary: `Resolved with note: ${input.resolutionNote}`,
      });

      res.status(200).json(resolved);
    }),
  );

  // Escalate Ticket with Mandatory Reason
  router.post(
    '/api/tickets/:id/escalate',
    requireAuth,
    requirePermission('tickets:claim'),
    asyncHandler(async (req, res) => {
      const input = escalateTicketSchema.parse(req.body);
      const escalated = await escalateTicket(req.sessionUser as any, req.params.id as string, input);

      void sendNotification({
        type: 'ticketEscalated',
        reference: escalated.reference,
        summary: `Escalated to ${input.tier}: ${input.reason}`,
      });

      res.status(200).json(escalated);
    }),
  );

  // Client Close and Rate Ticket
  router.post(
    '/api/tickets/:id/close',
    requireAuth,
    requirePermission('tickets:close'),
    asyncHandler(async (req, res) => {
      const input = ticketFeedbackSchema.parse(req.body);
      const closed = await closeAndRateTicket(req.sessionUser as any, req.params.id as string, input);
      res.status(200).json(closed);
    }),
  );

  // Client Reopen Ticket
  router.post(
    '/api/tickets/:id/reopen',
    requireAuth,
    requirePermission('tickets:create'),
    asyncHandler(async (req, res) => {
      const { reason } = req.body ?? {};
      const reopened = await reopenTicket(req.sessionUser as any, req.params.id as string, reason);
      res.status(200).json(reopened);
    }),
  );

  // Add Comment (Public or Internal)
  router.post(
    '/api/tickets/:id/comments',
    requireAuth,
    requirePermission('tickets:read'),
    asyncHandler(async (req, res) => {
      const input = addCommentSchema.parse(req.body);
      const comment = await addComment(
        req.sessionUser as any,
        req.params.id as string,
        input.content,
        input.visibility,
      );
      res.status(201).json(comment);
    }),
  );

  return router;
}
