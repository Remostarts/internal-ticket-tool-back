import mongoose, {
  Schema,
  model,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';

const PHASES = ['discovery', 'design', 'development', 'testing', 'deployment', 'maintenance'] as const;

const milestoneSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    phase: { type: String, enum: PHASES, required: true, index: true },
    targetDate: { type: Date, default: null },
    deliverables: { type: [String], default: [] },
    status: { type: String, enum: ['pending', 'reached'], default: 'pending', index: true },
    prdRunId: { type: Schema.Types.ObjectId, ref: 'PrdBreakdownRun', default: null, index: true },
    visibleOnBoard: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

milestoneSchema.index({ project: 1, phase: 1 });

export type MilestoneAttributes = InferSchemaType<typeof milestoneSchema>;
export type MilestoneDocument = HydratedDocument<MilestoneAttributes>;

export const Milestone: Model<MilestoneAttributes> =
  (mongoose.models.Milestone as Model<MilestoneAttributes> | undefined) ??
  model<MilestoneAttributes>('Milestone', milestoneSchema);
