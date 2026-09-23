import { z } from 'zod';
import { PERMISSIONS, ROLE_LADDER, type Permission } from '../permissions.js';

export const createCustomRoleSchema = z.object({
  name: z
    .string({ required_error: 'Enter a role name.' })
    .trim()
    .min(2, 'Role name must be at least 2 characters.')
    .max(50, 'Role name cannot exceed 50 characters.')
    .regex(/^[a-zA-Z0-9\s-_]+$/, 'Role name can only contain letters, numbers, spaces, hyphens and underscores.'),
  description: z.string().trim().max(300, 'Description cannot exceed 300 characters.').default(''),
  baseRole: z.enum([...ROLE_LADDER, 'client']).nullable().optional(),
  permissions: z
    .array(z.enum(PERMISSIONS))
    .min(1, 'Select at least one permission for this role.'),
});

export type CreateCustomRoleInput = z.infer<typeof createCustomRoleSchema>;

export const updateCustomRoleSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Role name must be at least 2 characters.')
    .max(50, 'Role name cannot exceed 50 characters.')
    .regex(/^[a-zA-Z0-9\s-_]+$/, 'Role name can only contain letters, numbers, spaces, hyphens and underscores.')
    .optional(),
  description: z.string().trim().max(300, 'Description cannot exceed 300 characters.').optional(),
  permissions: z.array(z.enum(PERMISSIONS)).min(1, 'Select at least one permission.').optional(),
});

export type UpdateCustomRoleInput = z.infer<typeof updateCustomRoleSchema>;

export interface CustomRoleDTO {
  id: string;
  name: string;
  slug: string;
  description: string;
  baseRole?: string | null;
  permissions: Permission[];
  userCount?: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: {
    id: string;
    fullName: string;
    email: string;
  } | null;
}
