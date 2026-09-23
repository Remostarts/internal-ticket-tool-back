import { Router } from 'express';
import {
  createEventSchema,
  updateEventSchema,
  renewEventSchema,
} from '@/shared';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePermission } from '../middleware/require-permission.js';
import {
  listEvents,
  createEvent,
  updateEvent,
  renewEvent,
} from '../services/events.js';

export function createEventsRouter(): Router {
  const router = Router();

  // List events (scoped)
  router.get(
    '/api/events',
    requireAuth,
    requirePermission('events:read'),
    asyncHandler(async (req, res) => {
      const projectId = req.query.projectId as string | undefined;
      const typeFilter = req.query.type as string | undefined;
      const events = await listEvents(req.sessionUser as any, projectId, typeFilter);
      res.status(200).json(events);
    }),
  );

  // Create event
  router.post(
    '/api/events',
    requireAuth,
    requirePermission('events:write'),
    asyncHandler(async (req, res) => {
      const input = createEventSchema.parse(req.body);
      const event = await createEvent(req.sessionUser as any, input);
      res.status(201).json(event);
    }),
  );

  // Update event
  router.patch(
    '/api/events/:id',
    requireAuth,
    requirePermission('events:write'),
    asyncHandler(async (req, res) => {
      const input = updateEventSchema.parse(req.body);
      const updated = await updateEvent(req.sessionUser as any, req.params.id as string, input);
      res.status(200).json(updated);
    }),
  );

  // Renew event
  router.post(
    '/api/events/:id/renew',
    requireAuth,
    requirePermission('events:write'),
    asyncHandler(async (req, res) => {
      const input = renewEventSchema.parse(req.body);
      const renewed = await renewEvent(req.sessionUser as any, req.params.id as string, input);
      res.status(201).json(renewed);
    }),
  );

  return router;
}
