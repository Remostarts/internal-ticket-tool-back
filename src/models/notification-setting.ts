import mongoose, {
  Schema,
  model,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';

/**
 * Notification setting model (S06, R036).
 */

const notificationSettingSchema = new Schema(
  {
    ticketCreated: { type: Boolean, default: true },
    ticketClaimed: { type: Boolean, default: true },
    ticketResolved: { type: Boolean, default: true },
    ticketEscalated: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export type NotificationSettingAttributes = InferSchemaType<typeof notificationSettingSchema>;
export type NotificationSettingDocument = HydratedDocument<NotificationSettingAttributes>;

export const NotificationSetting: Model<NotificationSettingAttributes> =
  (mongoose.models.NotificationSetting as Model<NotificationSettingAttributes> | undefined) ??
  model<NotificationSettingAttributes>('NotificationSetting', notificationSettingSchema);
