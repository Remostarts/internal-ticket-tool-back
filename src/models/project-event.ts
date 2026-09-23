import mongoose, { Schema, model, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

const eventSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    type: { type: String, enum: ['certificate', 'contract', 'maintenance'], required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    date: { type: Date, required: true, index: true },
    status: { type: String, enum: ['scheduled', 'in-progress', 'completed', 'cancelled'], default: 'scheduled', index: true },
    responsibleRole: { type: String, trim: true, default: 'developer' },
    linkedTicket: { type: Schema.Types.ObjectId, ref: 'Ticket', default: null },
    linkedTask: { type: Schema.Types.ObjectId, ref: 'Task', default: null },
    predecessorEvent: { type: Schema.Types.ObjectId, ref: 'ProjectEvent', default: null },
    certificateDetails: {
      issuer: { type: String, trim: true, default: '' },
      domain: { type: String, trim: true, default: '' },
      expiryDate: { type: Date, default: null },
    },
    contractDetails: {
      parties: { type: String, trim: true, default: '' },
      terms: { type: String, trim: true, default: '' },
      startDate: { type: Date, default: null },
      endDate: { type: Date, default: null },
    },
    maintenanceDetails: {
      window: { type: String, trim: true, default: '' },
      completedWork: { type: String, trim: true, default: '' },
      nextScheduled: { type: Date, default: null },
    },
    reminderSentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

eventSchema.index({ project: 1, date: 1 });
eventSchema.index({ date: 1, status: 1 });

export type ProjectEventAttributes = InferSchemaType<typeof eventSchema>;
export type ProjectEventDocument = HydratedDocument<ProjectEventAttributes>;

export const ProjectEvent: Model<ProjectEventAttributes> =
  (mongoose.models.ProjectEvent as Model<ProjectEventAttributes> | undefined) ??
  model<ProjectEventAttributes>('ProjectEvent', eventSchema);
