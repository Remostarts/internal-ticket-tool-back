import mongoose, {
  Schema,
  model,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { PRIORITIES, TICKET_STATUSES, TICKET_TYPES } from '@/shared';

/**
 * Ticket model (S02, R026, R030, R038).
 */

const attachmentSchema = new Schema(
  {
    url: { type: String, required: true },
    filename: { type: String, required: true },
    bytes: { type: Number, required: true },
    mimeType: { type: String, required: true },
  },
  { _id: false },
);

const ticketSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true, index: true },
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    requester: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    type: { type: String, enum: [...TICKET_TYPES], default: 'bug', index: true },
    priority: { type: String, enum: [...PRIORITIES], default: 'P3', index: true },
    status: { type: String, enum: [...TICKET_STATUSES], default: 'new', index: true },
    assignee: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    attachments: [attachmentSchema],
    resolutionNote: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    feedbackRating: { type: Number, default: null },
    feedbackNps: { type: Number, default: null },
    feedbackComment: { type: String, default: null },
    feedbackAt: { type: Date, default: null },
    escalatedAt: { type: Date, default: null },
    escalationTier: { type: String, default: null },
    escalationReason: { type: String, default: null },
    escalatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    lastActivityAt: { type: Date, required: true, default: () => new Date(), index: true },
  },
  { timestamps: true },
);

ticketSchema.index({ project: 1, status: 1, createdAt: -1 });
ticketSchema.index({ assignee: 1, status: 1 });
ticketSchema.index({ status: 1, priority: 1 });
ticketSchema.index({ createdAt: -1 });

export type TicketAttributes = InferSchemaType<typeof ticketSchema>;
export type TicketDocument = HydratedDocument<TicketAttributes>;

export const Ticket: Model<TicketAttributes> =
  (mongoose.models.Ticket as Model<TicketAttributes> | undefined) ??
  model<TicketAttributes>('Ticket', ticketSchema);
