import mongoose, {
  Schema,
  model,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { PRD_RUN_STATUSES } from '@/shared';

/**
 * Tracks a single AI PRD Breakdown run for a project.
 * status=draft means items are persisted but not yet visible on the board.
 * status=committed means the user confirmed and tasks are live in Todo.
 * status=archived means a previous committed run was replaced.
 * status=discarded means the draft was cancelled.
 *
 * A TTL index auto-expires uncommitted drafts after 24 hours.
 */
const prdBreakdownRunSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    sourceHash: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    milestoneIds: [{ type: Schema.Types.ObjectId, ref: 'Milestone' }],
    taskIds: [{ type: Schema.Types.ObjectId, ref: 'Task' }],
    status: { type: String, enum: [...PRD_RUN_STATUSES], default: 'draft', index: true },
    unresolvedDependencyWarnings: { type: [String], default: [] },
    infraEstimation: {
      apiCount: { type: Number, default: 0 },
      services: { type: [String], default: [] },
      notes: { type: String, default: '' },
    },
    // TTL: auto-delete draft documents after 24h of creation
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Only draft runs expire via TTL
prdBreakdownRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { status: 'draft' } });
prdBreakdownRunSchema.index({ project: 1, status: 1 });

export type PrdBreakdownRunAttributes = InferSchemaType<typeof prdBreakdownRunSchema>;
export type PrdBreakdownRunDocument = HydratedDocument<PrdBreakdownRunAttributes>;

export const PrdBreakdownRun: Model<PrdBreakdownRunAttributes> =
  (mongoose.models.PrdBreakdownRun as Model<PrdBreakdownRunAttributes> | undefined) ??
  model<PrdBreakdownRunAttributes>('PrdBreakdownRun', prdBreakdownRunSchema);
