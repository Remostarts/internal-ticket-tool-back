import { Router } from 'express';
import { profileUpdateSchema, changePasswordSchema } from '@/shared';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePermission } from '../middleware/require-permission.js';
import { getUserProfile, updateSelfProfile, changeUserPassword } from '../services/profile.js';
import { processUpload } from '../services/upload.js';

export function createProfileRouter(): Router {
  const router = Router();

  // Read profile
  router.get(
    '/api/users/:idOrUsername/profile',
    requireAuth,
    requirePermission('profile:read'),
    asyncHandler(async (req, res) => {
      const profile = await getUserProfile(req.params.idOrUsername as string);
      res.status(200).json(profile);
    }),
  );

  // Edit own profile
  router.patch(
    '/api/profile',
    requireAuth,
    requirePermission('profile:write:self'),
    asyncHandler(async (req, res) => {
      if (!req.sessionUser) {
        res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
        return;
      }
      const input = profileUpdateSchema.parse(req.body);
      const updated = await updateSelfProfile(req.sessionUser.id, input);
      res.status(200).json(updated);
    }),
  );

  // Change password for logged-in user
  router.post(
    '/api/profile/change-password',
    requireAuth,
    requirePermission('profile:write:self'),
    asyncHandler(async (req, res) => {
      if (!req.sessionUser) {
        res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
        return;
      }
      const input = changePasswordSchema.parse(req.body);
      await changeUserPassword(req.sessionUser.id, input);
      res.status(200).json({ success: true, message: 'Password changed successfully.' });
    }),
  );

  // Avatar / Asset upload
  router.post(
    '/api/upload',
    requireAuth,
    requirePermission('profile:write:self'),
    asyncHandler(async (req, res) => {
      // Handles JSON payload containing base64 data for universal transport
      const { data, filename, mimeType } = req.body;
      if (!data || !mimeType) {
        res.status(400).json({ code: 'VALIDATION_FAILED', message: 'File data and mimeType required' });
        return;
      }
      const buffer = Buffer.from(data, 'base64');
      const result = await processUpload({
        buffer,
        mimetype: mimeType,
        originalname: filename ?? 'upload',
        size: buffer.length,
      });
      res.status(200).json(result);
    }),
  );

  return router;
}
