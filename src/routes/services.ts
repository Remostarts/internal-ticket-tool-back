import { Router } from 'express';
import {
  createServiceSchema,
  createIncidentSchema,
  closeIncidentSchema,
} from '@/shared';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePermission } from '../middleware/require-permission.js';
import {
  listServices,
  createService,
  triggerManualCheck,
} from '../services/services.js';
import {
  listIncidents,
  createManualIncident,
  resolveManualIncident,
} from '../services/incidents.js';

export function createServicesRouter(): Router {
  const router = Router();

  // List services
  router.get(
    '/api/services',
    requireAuth,
    requirePermission('services:read'),
    asyncHandler(async (req, res) => {
      const projectId = req.query.projectId as string | undefined;
      const services = await listServices(req.sessionUser as any, projectId);
      res.status(200).json(services);
    }),
  );

  // Register new service
  router.post(
    '/api/services',
    requireAuth,
    requirePermission('services:write'),
    asyncHandler(async (req, res) => {
      const input = createServiceSchema.parse(req.body);
      const service = await createService(req.sessionUser as any, input);
      res.status(201).json(service);
    }),
  );

  // Trigger manual probe
  router.post(
    '/api/services/:id/check',
    requireAuth,
    requirePermission('services:write'),
    asyncHandler(async (req, res) => {
      const service = await triggerManualCheck(req.sessionUser as any, req.params.id as string);
      res.status(200).json(service);
    }),
  );

  // List incidents
  router.get(
    '/api/incidents',
    requireAuth,
    requirePermission('services:read'),
    asyncHandler(async (req, res) => {
      const projectId = req.query.projectId as string | undefined;
      const incidents = await listIncidents(req.sessionUser as any, projectId);
      res.status(200).json(incidents);
    }),
  );

  // Create manual incident
  router.post(
    '/api/incidents',
    requireAuth,
    requirePermission('services:write'),
    asyncHandler(async (req, res) => {
      const input = createIncidentSchema.parse(req.body);
      const incident = await createManualIncident(req.sessionUser as any, input);
      res.status(201).json(incident);
    }),
  );

  // Resolve incident
  router.post(
    '/api/incidents/:id/resolve',
    requireAuth,
    requirePermission('services:write'),
    asyncHandler(async (req, res) => {
      const input = closeIncidentSchema.parse(req.body);
      const incident = await resolveManualIncident(req.sessionUser as any, req.params.id as string, input);
      res.status(200).json(incident);
    }),
  );

  return router;
}
