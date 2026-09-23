import { z } from 'zod';

export const PRICING_SERVICE_TYPES = ['hosting', 'email', 'sms', 'storage', 'analytics', 'custom'] as const;
export type PricingServiceType = (typeof PRICING_SERVICE_TYPES)[number];

export const createPricingSchema = z.object({
  projectId: z.string().min(1, 'Project is required'),
  serviceName: z.string().trim().min(1, 'Service name is required').max(100),
  description: z.string().trim().max(500).default(''),
  serviceType: z.enum(PRICING_SERVICE_TYPES).default('custom'),
  monthlyCostCents: z.number().int().min(0, 'Monthly cost cannot be negative'),
  isActive: z.boolean().default(true),
});

export type CreatePricingInput = z.infer<typeof createPricingSchema>;

export const updatePricingSchema = createPricingSchema.partial();
export type UpdatePricingInput = z.infer<typeof updatePricingSchema>;

export interface ProjectPricingSummary {
  items: Array<{
    id: string;
    projectId: string;
    serviceName: string;
    description: string;
    serviceType: PricingServiceType;
    monthlyCostCents: number;
    monthlyCostFormatted: string;
    isActive: boolean;
    createdAt: Date;
  }>;
  totalMonthlyCostCents: number;
  totalMonthlyCostFormatted: string;
}

/** Formats USD minor units (cents) into $XX.XX display string */
export function formatUsd(cents: number): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(dollars);
}
