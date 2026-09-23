import { z } from 'zod';

export const ticketFeedbackSchema = z.object({
  rating: z.number().int().min(1, 'Rating must be between 1 and 5').max(5, 'Rating must be between 1 and 5'),
  nps: z.number().int().min(0, 'NPS must be between 0 and 10').max(10, 'NPS must be between 0 and 10'),
  comment: z.string().trim().max(500, 'Comment must be at most 500 characters').default(''),
});

export type TicketFeedbackInput = z.infer<typeof ticketFeedbackSchema>;
