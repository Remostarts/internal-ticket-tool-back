import { z } from 'zod';

/**
 * Project schemas (S01).
 */

export const createProjectSchema = z.object({
  name: z.string().trim().min(2, 'Project name must be at least 2 characters.').max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2, 'Slug must be at least 2 characters.')
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Slug can only contain lowercase letters, numbers, and hyphens.'),
  clientName: z.string().trim().min(2, 'Client name must be at least 2 characters.').max(100),
  description: z.string().trim().max(1000).default(''),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  clientName: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(1000).optional(),
  status: z.enum(['active', 'archived']).optional(),
});

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const createClientAccountSchema = z.object({
  projectId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid project ID'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(30)
    .regex(/^[a-z0-9._-]+$/, 'Valid username required.'),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(72),
  fullName: z.string().trim().min(1, 'Full name required.').max(100),
  phone: z.string().trim().max(30).default(''),
});

export type CreateClientAccountInput = z.infer<typeof createClientAccountSchema>;
