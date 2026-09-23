import mongoose, { Schema, model, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';
import { ASSET_TYPES } from '@/shared';

const featurePhaseSubSchema = new Schema(
  {
    featureName: { type: String, required: true, trim: true },
    phase: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
  },
  { _id: false },
);

const projectAssetSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    type: { type: String, enum: [...ASSET_TYPES], required: true, index: true },
    title: { type: String, required: true, trim: true },
    fileUrl: { type: String, default: null },
    fileName: { type: String, trim: true, default: '' },
    fileSizeBytes: { type: Number, default: 0 },
    mimeType: { type: String, trim: true, default: '' },
    featureBreakdown: [featurePhaseSubSchema],
  },
  { timestamps: true },
);

projectAssetSchema.index({ project: 1, type: 1 });

export type ProjectAssetAttributes = InferSchemaType<typeof projectAssetSchema>;
export type ProjectAssetDocument = HydratedDocument<ProjectAssetAttributes>;

export const ProjectAsset: Model<ProjectAssetAttributes> =
  (mongoose.models.ProjectAsset as Model<ProjectAssetAttributes> | undefined) ??
  model<ProjectAssetAttributes>('ProjectAsset', projectAssetSchema);
