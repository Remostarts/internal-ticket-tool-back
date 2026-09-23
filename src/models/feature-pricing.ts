import mongoose, { Schema, model, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';
import { PRICING_SERVICE_TYPES } from '@/shared';

const featurePricingSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    serviceName: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    serviceType: { type: String, enum: [...PRICING_SERVICE_TYPES], default: 'custom' },
    monthlyCostCents: { type: Number, required: true, default: 0, min: 0 },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

featurePricingSchema.index({ project: 1, isActive: 1 });

export type FeaturePricingAttributes = InferSchemaType<typeof featurePricingSchema>;
export type FeaturePricingDocument = HydratedDocument<FeaturePricingAttributes>;

export const FeaturePricing: Model<FeaturePricingAttributes> =
  (mongoose.models.FeaturePricing as Model<FeaturePricingAttributes> | undefined) ??
  model<FeaturePricingAttributes>('FeaturePricing', featurePricingSchema);
