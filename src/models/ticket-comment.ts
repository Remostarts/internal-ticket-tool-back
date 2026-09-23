import mongoose, {
  Schema,
  model,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';

/**
 * Ticket comment & activity model (S05, R032).
 */

const ticketCommentSchema = new Schema(
  {
    ticket: { type: Schema.Types.ObjectId, ref: 'Ticket', required: true, index: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true, trim: true },
    visibility: { type: String, enum: ['public', 'internal'], default: 'public', index: true },
    isSystemEvent: { type: Boolean, default: false },
  },
  { timestamps: true },
);

ticketCommentSchema.index({ ticket: 1, createdAt: 1 });

export type TicketCommentAttributes = InferSchemaType<typeof ticketCommentSchema>;
export type TicketCommentDocument = HydratedDocument<TicketCommentAttributes>;

export const TicketComment: Model<TicketCommentAttributes> =
  (mongoose.models.TicketComment as Model<TicketCommentAttributes> | undefined) ??
  model<TicketCommentAttributes>('TicketComment', ticketCommentSchema);
