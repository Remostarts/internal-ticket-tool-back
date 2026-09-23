import { z } from 'zod';

/**
 * Organization and Reporting Lines Schemas (S05).
 */

export const updateManagerSchema = z.object({
  managerId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, 'Manager ID must be a valid 24-character ID')
    .nullable(),
});

export type UpdateManagerInput = z.infer<typeof updateManagerSchema>;
