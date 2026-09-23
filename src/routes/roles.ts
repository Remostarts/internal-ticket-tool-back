import { Router } from 'express';
import {
  createCustomRoleSchema,
  updateCustomRoleSchema,
} from '@/shared';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePermission } from '../middleware/require-permission.js';
import {
  listRolesWithMetrics,
  createCustomRole,
  getCustomRoleById,
  updateCustomRole,
  deleteCustomRole,
} from '../services/roles.js';

export function createRolesRouter(): Router {
  const router = Router();

  // List all standard and custom roles with user counts
  router.get(
    '/api/roles',
    requireAuth,
    requirePermission('user:read'),
    asyncHandler(async (_req, res) => {
      const data = await listRolesWithMetrics();
      res.status(200).json(data);
    }),
  );

  // Create a new custom role
  router.post(
    '/api/roles',
    requireAuth,
    requirePermission('role:assign'),
    asyncHandler(async (req, res) => {
      const input = createCustomRoleSchema.parse(req.body);
      const authorId = req.sessionUser?._id?.toString() || req.identity?.user?._id?.toString() || '';
      const role = await createCustomRole(input, authorId);
      res.status(201).json(role);
    }),
  );

  // Get custom role by ID
  router.get(
    '/api/roles/:id',
    requireAuth,
    requirePermission('user:read'),
    asyncHandler(async (req, res) => {
      const role = await getCustomRoleById(req.params.id as string);
      res.status(200).json(role);
    }),
  );

  // Update custom role
  router.patch(
    '/api/roles/:id',
    requireAuth,
    requirePermission('role:assign'),
    asyncHandler(async (req, res) => {
      const input = updateCustomRoleSchema.parse(req.body);
      const authorId = req.sessionUser?._id?.toString() || req.identity?.user?._id?.toString() || '';
      const updated = await updateCustomRole(req.params.id as string, input, authorId);
      res.status(200).json(updated);
    }),
  );

  // Delete custom role
  router.delete(
    '/api/roles/:id',
    requireAuth,
    requirePermission('role:assign'),
    asyncHandler(async (req, res) => {
      const authorId = req.sessionUser?._id?.toString() || req.identity?.user?._id?.toString() || '';
      await deleteCustomRole(req.params.id as string, authorId);
      res.status(200).json({ ok: true });
    }),
  );

  return router;
}
