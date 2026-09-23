import { z } from 'zod';
import { PRIORITIES } from '../priority.js';

export const resolveTicketSchema = z.object({
  resolutionNote: z
    .string({ required_error: 'A resolution note is required to resolve a ticket.' })
    .trim()
    .min(5, 'Resolution note must be at least 5 characters.')
    .max(5000),
});

export type ResolveTicketInput = z.infer<typeof resolveTicketSchema>;

export const escalateTicketSchema = z.object({
  reason: z
    .string({ required_error: 'Reason for escalation is required.' })
    .trim()
    .min(5, 'Escalation reason must be at least 5 characters.')
    .max(2000),
  tier: z.enum(['Tier 2 Support', 'Engineering', 'Leadership', 'CTO Office']).default('Tier 2 Support'),
});

export type EscalateTicketInput = z.infer<typeof escalateTicketSchema>;

export const assignTicketSchema = z.object({
  assigneeId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid assignee user ID').nullable(),
});

export type AssignTicketInput = z.infer<typeof assignTicketSchema>;

export const addCommentSchema = z.object({
  content: z.string().trim().min(1, 'Comment cannot be empty.').max(5000),
  visibility: z.enum(['public', 'internal']).default('public'),
});

export type AddCommentInput = z.infer<typeof addCommentSchema>;

export const bulkTicketActionSchema = z.object({
  ticketIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).min(1).max(50),
  action: z.enum(['assign', 'set_priority', 'close']),
  assigneeId: z.string().optional(),
  priority: z.enum(PRIORITIES).optional(),
});

export type BulkTicketActionInput = z.infer<typeof bulkTicketActionSchema>;
