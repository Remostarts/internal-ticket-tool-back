import mongoose, {
  Schema,
  model,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';

/**
 * The Project model (S01, R023).
 * Represents a project and client tenancy boundary.
 */

const projectSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    clientName: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
    members: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true },
);

projectSchema.index({ clientName: 1, status: 1 });

export type ProjectAttributes = InferSchemaType<typeof projectSchema>;
export type ProjectDocument = HydratedDocument<ProjectAttributes>;

export const Project: Model<ProjectAttributes> =
  (mongoose.models.Project as Model<ProjectAttributes> | undefined) ??
  model<ProjectAttributes>('Project', projectSchema);
