import { z } from 'zod';

export const SERVICE_STATUSES = ['up', 'degraded', 'down', 'unknown'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const SERVICE_CADENCES = [1, 5, 15, 30] as const;
export type ServiceCadence = (typeof SERVICE_CADENCES)[number];

export const createServiceSchema = z.object({
  projectId: z.string().min(1, 'Project is required'),
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  url: z.string().url('Must be a valid HTTP or HTTPS URL'),
  cadenceMinutes: z.enum(['1', '5', '15', '30']).transform(Number).pipe(z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(30)])),
  degradedResponseMs: z.number().int().min(10).default(1500),
  downAfterConsecutiveFailures: z.number().int().min(1).default(3),
  enabled: z.boolean().default(true),
  notes: z.string().max(500).optional(),
});

export type CreateServiceInput = z.infer<typeof createServiceSchema>;

export const updateServiceSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  url: z.string().url().optional(),
  cadenceMinutes: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(30)]).optional(),
  degradedResponseMs: z.number().int().min(10).optional(),
  downAfterConsecutiveFailures: z.number().int().min(1).optional(),
  enabled: z.boolean().optional(),
  notes: z.string().max(500).optional(),
});

export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;

export const createIncidentSchema = z.object({
  serviceId: z.string().min(1),
  title: z.string().min(3).max(150),
  summary: z.string().min(5).max(1000),
  severity: z.enum(['minor', 'major', 'critical']).default('major'),
});

export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;

export const closeIncidentSchema = z.object({
  resolutionNote: z.string().min(5).max(1000),
});

export type CloseIncidentInput = z.infer<typeof closeIncidentSchema>;
