import mongoose, {
  Schema,
  model,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { PERMISSIONS, ROLE_LADDER } from '@/shared';

const customRoleSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, trim: true, default: '' },
    baseRole: { type: String, enum: [...ROLE_LADDER, 'client', null], default: null },
    permissions: [{ type: String, enum: PERMISSIONS, required: true }],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

export type CustomRoleAttributes = InferSchemaType<typeof customRoleSchema>;
export type CustomRoleDocument = HydratedDocument<CustomRoleAttributes>;

export const CustomRole: Model<CustomRoleAttributes> =
  (mongoose.models.CustomRole as Model<CustomRoleAttributes> | undefined) ??
  model<CustomRoleAttributes>('CustomRole', customRoleSchema);
