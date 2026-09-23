import mongoose, { Schema, type Document, type Types } from 'mongoose';

export interface IncidentDocument extends Document {
  service: Types.ObjectId;
  project: Types.ObjectId;
  title: string;
  summary: string;
  severity: 'minor' | 'major' | 'critical';
  status: 'open' | 'resolved';
  openedAt: Date;
  resolvedAt?: Date;
  resolutionNote?: string;
  isAutomated: boolean;
  timeline: Array<{
    timestamp: Date;
    message: string;
    actor?: string;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const IncidentSchema = new Schema<IncidentDocument>(
  {
    service: { type: Schema.Types.ObjectId, ref: 'Service', required: true, index: true },
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    title: { type: String, required: true, trim: true },
    summary: { type: String, required: true, trim: true },
    severity: { type: String, enum: ['minor', 'major', 'critical'], default: 'major' },
    status: { type: String, enum: ['open', 'resolved'], default: 'open', index: true },
    openedAt: { type: Date, default: Date.now, index: true },
    resolvedAt: { type: Date },
    resolutionNote: { type: String, trim: true },
    isAutomated: { type: Boolean, default: true },
    timeline: [
      {
        timestamp: { type: Date, default: Date.now },
        message: { type: String, required: true },
        actor: { type: String },
      },
    ],
  },
  { timestamps: true },
);

export const Incident =
  (mongoose.models.Incident as mongoose.Model<IncidentDocument>) ??
  mongoose.model<IncidentDocument>('Incident', IncidentSchema);
