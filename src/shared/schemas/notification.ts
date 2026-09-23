import { z } from 'zod';

export const updateNotificationSettingsSchema = z.object({
  ticketCreated: z.boolean().optional(),
  ticketClaimed: z.boolean().optional(),
  ticketResolved: z.boolean().optional(),
  ticketEscalated: z.boolean().optional(),
});

export type UpdateNotificationSettingsInput = z.infer<typeof updateNotificationSettingsSchema>;
