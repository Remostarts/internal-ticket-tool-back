import { z } from 'zod';

/**
 * Profile and Upload Schemas (S04).
 */

export const profileUpdateSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name cannot be empty.').max(100).optional(),
  phone: z.string().trim().max(30).optional(),
  bio: z.string().trim().max(2000, 'Bio must be at most 2000 characters.').optional(),
  pictureUrl: z.string().url('Must be a valid URL.').optional().nullable(),
});

export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.'),
  newPassword: z.string().min(8, 'Use at least 8 characters.').max(72, 'Use at most 72 characters.'),
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const uploadResponseSchema = z.object({
  url: z.string().url(),
  publicId: z.string(),
  bytes: z.number().int().positive(),
  mime: z.string(),
});

export type UploadResponse = z.infer<typeof uploadResponseSchema>;
