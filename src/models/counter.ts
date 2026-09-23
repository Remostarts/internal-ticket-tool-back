import mongoose, {
  Schema,
  model,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';

/**
 * Atomic Counter model for day-based unique sequence generation (S02, R026).
 */

const counterSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    sequence: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

export type CounterAttributes = InferSchemaType<typeof counterSchema>;
export type CounterDocument = HydratedDocument<CounterAttributes>;

export const Counter: Model<CounterAttributes> =
  (mongoose.models.Counter as Model<CounterAttributes> | undefined) ??
  model<CounterAttributes>('Counter', counterSchema);
