import { Router } from 'express';
import {
  userQuerySchema,
  createUserSchema,
  updateUserSchema,
  bulkRoleSchema,
} from '@/shared';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePermission } from '../middleware/require-permission.js';
import { queryUserDirectory } from '../services/user-directory.js';
import { createUser, updateUser } from '../services/user-write.js';
import { bulkAssignRoles } from '../services/roles.js';

export function createUsersRouter(): Router {
  const router = Router();

  router.get(
    '/api/users',
    requireAuth,
    requirePermission('user:read'),
    asyncHandler(async (req, res) => {
      const query = userQuerySchema.parse(req.query);
      const result = await queryUserDirectory(query);
      res.status(200).json(result);
    }),
  );

  router.post(
    '/api/users',
    requireAuth,
    requirePermission('user:write'),
    asyncHandler(async (req, res) => {
      const input = createUserSchema.parse(req.body);
      const created = await createUser(req.sessionUser?.id ?? null, input);
      res.status(201).json(created);
    }),
  );

  router.patch(
    '/api/users/:id',
    requireAuth,
    requirePermission('user:write'),
    asyncHandler(async (req, res) => {
      const input = updateUserSchema.parse(req.body);
      const updated = await updateUser(req.sessionUser?.id ?? null, req.params.id as string, input);
      res.status(200).json(updated);
    }),
  );

  router.post(
    '/api/users/bulk-role',
    requireAuth,
    requirePermission('role:assign'),
    asyncHandler(async (req, res) => {
      const input = bulkRoleSchema.parse(req.body);
      const result = await bulkAssignRoles(req.sessionUser?.id ?? null, input.userIds, input.role);
      res.status(200).json(result);
    }),
  );

  return router;
}
