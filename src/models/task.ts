import mongoose, {
  Schema,
  model,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { PRIORITIES, TASK_COLUMNS, PRD_TASK_TYPES } from '@/shared';

/**
 * Task model (M004, R045, R046, R047).
 */

const taskSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: false, default: null, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    priority: { type: String, enum: [...PRIORITIES], default: 'P3', index: true },
    column: { type: String, enum: [...TASK_COLUMNS], default: 'backlog', index: true },
    position: { type: Number, default: 0, index: true },
    assignee: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    creator: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    parent: { type: Schema.Types.ObjectId, ref: 'Task', default: null },
    ticket: { type: Schema.Types.ObjectId, ref: 'Ticket', default: null, index: true },
    dueDate: { type: Date, default: null, index: true },
    // PRD Breakdown fields
    milestoneId: { type: Schema.Types.ObjectId, ref: 'Milestone', default: null, index: true },
    prdRunId: { type: Schema.Types.ObjectId, ref: 'PrdBreakdownRun', default: null, index: true },
    blockedByIds: [{ type: Schema.Types.ObjectId, ref: 'Task' }],
    blocksIds: [{ type: Schema.Types.ObjectId, ref: 'Task' }],
    acceptanceCriteria: [
      {
        text: { type: String, required: true },
        done: { type: Boolean, default: false },
      },
    ],
    type: { type: String, enum: [...PRD_TASK_TYPES], default: null },
    isRiskSpike: { type: Boolean, default: false },
    riskNotes: { type: String, default: '' },
    visibleOnBoard: { type: Boolean, default: true, index: true },
    isPersonal: { type: Boolean, default: false, index: true },
    featureChecklist: {
      figma: { type: Boolean, default: false },
      development: { type: Boolean, default: false },
      testing: { type: Boolean, default: false },
      deployed: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
);

taskSchema.index({ project: 1, column: 1, position: 1 });
taskSchema.index({ parent: 1 });
taskSchema.index({ project: 1, dueDate: 1 });

export type TaskAttributes = InferSchemaType<typeof taskSchema>;
export type TaskDocument = HydratedDocument<TaskAttributes>;

export const Task: Model<TaskAttributes> =
  (mongoose.models.Task as Model<TaskAttributes> | undefined) ??
  model<TaskAttributes>('Task', taskSchema);
