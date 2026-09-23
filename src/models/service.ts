import mongoose, { Schema, type Document, type Types } from 'mongoose';
import type { ServiceStatus, ServiceCadence } from '@/shared';

export interface ServiceDocument extends Document {
  project: Types.ObjectId;
  name: string;
  url: string;
  cadenceMinutes: ServiceCadence;
  degradedResponseMs: number;
  downAfterConsecutiveFailures: number;
  enabled: boolean;
  notes?: string;
  lastStatus: ServiceStatus;
  lastResponseMs?: number;
  lastCheckedAt?: Date;
  nextCheckAt: Date;
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
}

const ServiceSchema = new Schema<ServiceDocument>(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    cadenceMinutes: { type: Number, required: true, enum: [1, 5, 15, 30], default: 5 },
    degradedResponseMs: { type: Number, default: 1500 },
    downAfterConsecutiveFailures: { type: Number, default: 3 },
    enabled: { type: Boolean, default: true, index: true },
    notes: { type: String, trim: true },
    lastStatus: { type: String, enum: ['up', 'degraded', 'down', 'unknown'], default: 'unknown', index: true },
    lastResponseMs: { type: Number },
    lastCheckedAt: { type: Date },
    nextCheckAt: { type: Date, default: Date.now, index: true },
    consecutiveFailures: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const Service =
  (mongoose.models.Service as mongoose.Model<ServiceDocument>) ??
  mongoose.model<ServiceDocument>('Service', ServiceSchema);
