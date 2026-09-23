import { Router } from 'express';
import { dashboardQuerySchema } from '@/shared';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePermission } from '../middleware/require-permission.js';
import { getDashboardData } from '../services/dashboard.js';

export function createDashboardRouter(): Router {
  const router = Router();

  // Unified Dashboard Endpoint
  router.get(
    '/api/dashboard',
    requireAuth,
    requirePermission('dashboard:read'),
    asyncHandler(async (req, res) => {
      const query = dashboardQuerySchema.parse(req.query);
      const data = await getDashboardData(req.sessionUser as any, query);
      res.status(200).json(data);
    }),
  );

  return router;
}
