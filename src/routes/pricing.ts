import { Router } from 'express';
import {
  createPricingSchema,
  updatePricingSchema,
} from '@/shared';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePermission } from '../middleware/require-permission.js';
import {
  getProjectPricing,
  createPricingItem,
  updatePricingItem,
  deletePricingItem,
} from '../services/pricing.js';

export function createPricingRouter(): Router {
  const router = Router();

  // Get pricing for project (read-only for clients and staff)
  router.get(
    '/api/projects/:projectId/pricing',
    requireAuth,
    requirePermission('pricing:read'),
    asyncHandler(async (req, res) => {
      const summary = await getProjectPricing(req.sessionUser as any, req.params.projectId as string);
      res.status(200).json(summary);
    }),
  );

  // Add pricing item (Management / Admin)
  router.post(
    '/api/pricing',
    requireAuth,
    requirePermission('pricing:write'),
    asyncHandler(async (req, res) => {
      const input = createPricingSchema.parse(req.body);
      const item = await createPricingItem(req.sessionUser as any, input);
      res.status(201).json(item);
    }),
  );

  // Update pricing item
  router.patch(
    '/api/pricing/:id',
    requireAuth,
    requirePermission('pricing:write'),
    asyncHandler(async (req, res) => {
      const input = updatePricingSchema.parse(req.body);
      const updated = await updatePricingItem(req.sessionUser as any, req.params.id as string, input);
      res.status(200).json(updated);
    }),
  );

  // Delete pricing item
  router.delete(
    '/api/pricing/:id',
    requireAuth,
    requirePermission('pricing:write'),
    asyncHandler(async (req, res) => {
      await deletePricingItem(req.sessionUser as any, req.params.id as string);
      res.status(200).json({ ok: true });
    }),
  );

  return router;
}
