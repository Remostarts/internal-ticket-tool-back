import { z } from 'zod';
import { PRIORITIES } from '../priority.js';

export const TICKET_STATUSES = ['new', 'in-progress', 'resolved', 'closed', 'escalated'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_TYPES = ['bug', 'feature', 'support', 'incident', 'request'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const createTicketSchema = z.object({
  projectId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid project ID'),
  title: z.string().trim().min(3, 'Title must be at least 3 characters.').max(200),
  description: z.string().trim().min(5, 'Description must be at least 5 characters.').max(10000),
  type: z.enum(TICKET_TYPES).default('bug'),
  priority: z.enum(PRIORITIES).default('P3'),
  attachments: z
    .array(
      z.object({
        url: z.string().url(),
        filename: z.string(),
        bytes: z.number().int().positive(),
        mimeType: z.string(),
      }),
    )
    .max(5, 'At most 5 attachments allowed.')
    .default([]),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const ticketQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  queue: z.enum(['all', 'unclaimed', 'my_tickets', 'urgent', 'closed']).default('all'),
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  projectId: z.string().optional(),
  assigneeId: z.string().optional(),
  search: z.string().trim().optional(),
  sort: z.enum(['createdAt', 'lastActivityAt', 'priority', 'status']).default('lastActivityAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type TicketQueryInput = z.infer<typeof ticketQuerySchema>;
