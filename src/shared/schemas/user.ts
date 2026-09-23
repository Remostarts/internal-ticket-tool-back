import { z } from 'zod';

/**
 * User Schemas (S03).
 */

export const userQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(100).optional(),
  role: z.string().optional(),
  department: z.string().trim().max(100).optional(),
  active: z
    .enum(['true', 'false'])
    .transform((val) => val === 'true')
    .optional(),
  sort: z.enum(['name', 'email', 'createdAt', 'role']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type UserQueryInput = z.infer<typeof userQuerySchema>;

export const createUserSchema = z.object({
  email: z
    .string({ required_error: 'Enter an email address.' })
    .trim()
    .toLowerCase()
    .min(1, 'Enter an email address.')
    .email('Enter a valid email address.'),
  username: z
    .string({ required_error: 'Enter a username.' })
    .trim()
    .toLowerCase()
    .min(3, 'Username must be at least 3 characters.')
    .max(30, 'Username must be at most 30 characters.')
    .regex(/^[a-z0-9._-]+$/, 'Username can only contain letters, numbers, dots, hyphens and underscores.'),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(72),
  role: z.string().min(1).default('developer'),
  customRoleId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid custom role ID').nullable().optional(),
  fullName: z.string().trim().min(1, 'Enter full name.').max(100),
  department: z.string().trim().max(100).default(''),
  phone: z.string().trim().max(30).default(''),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  role: z.string().optional(),
  customRoleId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid custom role ID').nullable().optional(),
  active: z.boolean().optional(),
  department: z.string().trim().max(100).optional(),
  fullName: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().max(30).optional(),
});

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const bulkRoleSchema = z.object({
  userIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid user ID')).min(1, 'Select at least one user.').max(100, 'Cannot update more than 100 users at once.'),
  role: z.string().min(1, 'Select a valid role.'),
  customRoleId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid custom role ID').nullable().optional(),
});

export type BulkRoleInput = z.infer<typeof bulkRoleSchema>;
