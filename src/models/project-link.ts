import mongoose, { Schema, model, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';
import { LINK_KINDS } from '@/shared';

const projectLinkSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    kind: { type: String, enum: [...LINK_KINDS], required: true },
    label: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    notes: { type: String, trim: true, default: '' },
    position: { type: Number, default: 0 },
  },
  { timestamps: true },
);

projectLinkSchema.index({ project: 1, position: 1 });

export type ProjectLinkAttributes = InferSchemaType<typeof projectLinkSchema>;
export type ProjectLinkDocument = HydratedDocument<ProjectLinkAttributes>;

export const ProjectLink: Model<ProjectLinkAttributes> =
  (mongoose.models.ProjectLink as Model<ProjectLinkAttributes> | undefined) ??
  model<ProjectLinkAttributes>('ProjectLink', projectLinkSchema);
