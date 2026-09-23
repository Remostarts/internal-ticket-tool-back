import { Router } from 'express';
import { updateManagerSchema } from '@/shared';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePermission } from '../middleware/require-permission.js';
import { getOrgChart, updateUserManager } from '../services/org.js';

export function createOrgRouter(): Router {
  const router = Router();

  // Read Org Chart
  router.get(
    '/api/org-chart',
    requireAuth,
    requirePermission('org:read'),
    asyncHandler(async (_req, res) => {
      const chart = await getOrgChart();
      res.status(200).json(chart);
    }),
  );

  // Update a user's manager (requires user:write)
  router.put(
    '/api/users/:id/manager',
    requireAuth,
    requirePermission('user:write'),
    asyncHandler(async (req, res) => {
      const input = updateManagerSchema.parse(req.body);
      const updated = await updateUserManager(req.sessionUser?.id ?? null, req.params.id as string, input.managerId);
      res.status(200).json(updated);
    }),
  );

  return router;
}
