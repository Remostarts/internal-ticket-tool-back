import mongoose, {
  Schema,
  model,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { ROLES } from '@/shared';

/**
 * Escalation Rule model (M003, R042).
 */

const escalationRuleSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
    fromRole: { type: String, enum: [...ROLES], required: true },
    toRole: { type: String, enum: [...ROLES], required: true },
    triggerHours: { type: Number, required: true, default: 24 },
    p1TriggerHours: { type: Number, required: true, default: 4 },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

escalationRuleSchema.index({ project: 1, fromRole: 1 });

export type EscalationRuleAttributes = InferSchemaType<typeof escalationRuleSchema>;
export type EscalationRuleDocument = HydratedDocument<EscalationRuleAttributes>;

export const EscalationRule: Model<EscalationRuleAttributes> =
  (mongoose.models.EscalationRule as Model<EscalationRuleAttributes> | undefined) ??
  model<EscalationRuleAttributes>('EscalationRule', escalationRuleSchema);
