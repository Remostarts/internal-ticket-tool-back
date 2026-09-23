import { z } from 'zod';

export const LINK_KINDS = [
  'figma',
  'openapi',
  'postman',
  'third_party_docs',
  'prd',
  'frontend_local',
  'frontend_staging',
  'frontend_production',
  'testing_dashboard',
  'custom',
] as const;

export type LinkKind = (typeof LINK_KINDS)[number];

const safeUrlSchema = z
  .string()
  .trim()
  .url('Must be a valid URL')
  .refine((url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Only HTTP and HTTPS URLs are permitted');

export const createProjectLinkSchema = z.object({
  projectId: z.string().min(1, 'Project is required'),
  kind: z.enum(LINK_KINDS),
  label: z.string().trim().min(1, 'Label is required').max(100),
  url: safeUrlSchema,
  notes: z.string().trim().max(500).default(''),
  position: z.number().int().default(0),
});

export type CreateProjectLinkInput = z.infer<typeof createProjectLinkSchema>;

export const updateProjectLinkSchema = createProjectLinkSchema.partial();

export type UpdateProjectLinkInput = z.infer<typeof updateProjectLinkSchema>;

export const reorderProjectLinksSchema = z.object({
  linkIds: z.array(z.string().min(1)),
});

export type ReorderProjectLinksInput = z.infer<typeof reorderProjectLinksSchema>;
