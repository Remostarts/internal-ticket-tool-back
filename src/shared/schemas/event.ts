import { z } from 'zod';

export const EVENT_TYPES = ['certificate', 'contract', 'maintenance'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_STATUSES = ['scheduled', 'in-progress', 'completed', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_URGENCIES = ['upcoming', 'due-soon', 'overdue'] as const;
export type EventUrgency = (typeof EVENT_URGENCIES)[number];

export const createEventSchema = z.object({
  projectId: z.string().min(1, 'Project is required'),
  type: z.enum(EVENT_TYPES),
  title: z.string().trim().min(1, 'Title is required').max(200),
  description: z.string().trim().default(''),
  date: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)),
  responsibleRole: z.string().trim().default('developer'),
  linkedTicketId: z.string().optional().nullable(),
  linkedTaskId: z.string().optional().nullable(),
  // Type-specific details:
  certificateDetails: z
    .object({
      issuer: z.string().trim().default(''),
      domain: z.string().trim().default(''),
      expiryDate: z.string().optional().nullable(),
    })
    .optional(),
  contractDetails: z
    .object({
      parties: z.string().trim().default(''),
      terms: z.string().trim().default(''),
      startDate: z.string().optional().nullable(),
      endDate: z.string().optional().nullable(),
    })
    .optional(),
  maintenanceDetails: z
    .object({
      window: z.string().trim().default(''),
      completedWork: z.string().trim().default(''),
      nextScheduled: z.string().optional().nullable(),
    })
    .optional(),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;

export const updateEventSchema = createEventSchema.partial().extend({
  status: z.enum(EVENT_STATUSES).optional(),
});

export type UpdateEventInput = z.infer<typeof updateEventSchema>;

export const renewEventSchema = z.object({
  newDate: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)),
  description: z.string().trim().optional(),
});

export type RenewEventInput = z.infer<typeof renewEventSchema>;

/**
 * Derives urgency:
 * - 'overdue': event date is before now and status is not 'completed' or 'cancelled'
 * - 'due-soon': within windowDays (default 30 days)
 * - 'upcoming': further out than windowDays
 */
export function computeEventUrgency(eventDate: Date | string, status: EventStatus, windowDays = 30): EventUrgency {
  if (status === 'completed' || status === 'cancelled') {
    return 'upcoming';
  }
  const now = Date.now();
  const target = new Date(eventDate).getTime();
  if (target < now) {
    return 'overdue';
  }
  const diffDays = (target - now) / (1000 * 60 * 60 * 24);
  if (diffDays <= windowDays) {
    return 'due-soon';
  }
  return 'upcoming';
}
