import { z } from 'zod';

export const DASHBOARD_PERIODS = ['7d', '30d', '90d', 'custom'] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

export const DASHBOARD_SCOPES = ['self', 'project', 'organization'] as const;
export type DashboardScope = (typeof DASHBOARD_SCOPES)[number];

export const dashboardQuerySchema = z.object({
  projectId: z.string().optional(),
  period: z.enum(['7d', '30d', '90d', 'custom']).default('30d'),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  scope: z.enum(['self', 'project', 'organization']).optional(),
});

export type DashboardQueryInput = z.infer<typeof dashboardQuerySchema>;

/**
 * Standard Net Promoter Score (NPS) calculation:
 * Promoters (score 9-10), Passives (7-8), Detractors (0-6).
 * NPS = % Promoters - % Detractors (rounded integer from -100 to +100).
 */
export function computeNps(ratings: number[]): {
  nps: number | null;
  promoters: number;
  passives: number;
  detractors: number;
  total: number;
  promoterPct: number;
  detractorPct: number;
} {
  if (ratings.length === 0) {
    return {
      nps: null,
      promoters: 0,
      passives: 0,
      detractors: 0,
      total: 0,
      promoterPct: 0,
      detractorPct: 0,
    };
  }

  let promoters = 0;
  let passives = 0;
  let detractors = 0;

  for (const r of ratings) {
    if (r >= 9) promoters++;
    else if (r >= 7) passives++;
    else detractors++;
  }

  const total = ratings.length;
  const promoterPct = Math.round((promoters / total) * 100);
  const detractorPct = Math.round((detractors / total) * 100);
  const nps = promoterPct - detractorPct;

  return {
    nps,
    promoters,
    passives,
    detractors,
    total,
    promoterPct,
    detractorPct,
  };
}
