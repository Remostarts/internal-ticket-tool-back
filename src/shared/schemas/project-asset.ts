import { z } from 'zod';

export const ASSET_TYPES = ['logo', 'requirements_doc', 'feature_breakdown', 'other'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const featurePhaseSchema = z.object({
  featureName: z.string().trim().min(1, 'Feature name is required'),
  phase: z.string().trim().min(1, 'Phase is required'), // e.g. "Phase 1 - MVP", "Phase 2"
  description: z.string().trim().default(''),
});

export type FeaturePhaseItem = z.infer<typeof featurePhaseSchema>;

export const createProjectAssetSchema = z.object({
  projectId: z.string().min(1, 'Project is required'),
  type: z.enum(ASSET_TYPES),
  title: z.string().trim().min(1, 'Title is required').max(150),
  fileUrl: z.string().url('File URL must be valid').optional().nullable(),
  fileName: z.string().trim().default(''),
  fileSizeBytes: z.number().int().max(10 * 1024 * 1024, 'Asset cannot exceed 10MB').default(0),
  mimeType: z.string().trim().default(''),
  featureBreakdown: z.array(featurePhaseSchema).optional().nullable(),
});

export type CreateProjectAssetInput = z.infer<typeof createProjectAssetSchema>;

export const updateProjectAssetSchema = createProjectAssetSchema.partial();
export type UpdateProjectAssetInput = z.infer<typeof updateProjectAssetSchema>;

export interface ProjectProgressSummary {
  projectId: string;
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  backlogTasks: number;
  percentage: number | null; // null if totalTasks is 0
  roadmap?: {
    inProgress: Array<{ id: string; title: string; priority: string; column: string }>;
    upcoming: Array<{ id: string; title: string; priority: string; column: string }>;
    completed: Array<{ id: string; title: string; priority: string; column: string }>;
  };
}
