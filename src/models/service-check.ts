import mongoose, { Schema, type Document, type Types } from 'mongoose';

export interface ServiceCheckDocument extends Document {
  service: Types.ObjectId;
  project: Types.ObjectId;
  status: 'up' | 'degraded' | 'down';
  responseMs: number;
  statusCode?: number;
  errorMessage?: string;
  checkedAt: Date;
  createdAt: Date;
}

const ServiceCheckSchema = new Schema<ServiceCheckDocument>(
  {
    service: { type: Schema.Types.ObjectId, ref: 'Service', required: true, index: true },
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    status: { type: String, required: true, enum: ['up', 'degraded', 'down'] },
    responseMs: { type: Number, required: true },
    statusCode: { type: Number },
    errorMessage: { type: String },
    checkedAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ServiceCheckSchema.index({ service: 1, createdAt: -1 });

// Historical health-check retention TTL index (default 90 days, configurable via SERVICE_CHECK_RETENTION_SECONDS)
const RETENTION_SECONDS = process.env.SERVICE_CHECK_RETENTION_SECONDS
  ? parseInt(process.env.SERVICE_CHECK_RETENTION_SECONDS, 10)
  : 90 * 24 * 60 * 60; // default 90 days

ServiceCheckSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

export const ServiceCheck =
  (mongoose.models.ServiceCheck as mongoose.Model<ServiceCheckDocument>) ??
  mongoose.model<ServiceCheckDocument>('ServiceCheck', ServiceCheckSchema);
