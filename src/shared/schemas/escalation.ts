import { z } from 'zod';
import { ROLES } from '../permissions.js';

export const escalationRuleSchema = z.object({
  projectId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid project ID').nullable().optional(),
  fromRole: z.enum(ROLES),
  toRole: z.enum(ROLES),
  triggerHours: z.number().int().min(1).max(720).default(24),
  p1TriggerHours: z.number().int().min(1).max(168).default(4),
  isActive: z.boolean().default(true),
});

export type EscalationRuleInput = z.infer<typeof escalationRuleSchema>;

export const auditExportQuerySchema = z.object({
  actor: z.string().optional(),
  action: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  format: z.enum(['csv', 'json']).default('csv'),
});

export type AuditExportQueryInput = z.infer<typeof auditExportQuerySchema>;
