import mongoose, {
  Schema,
  model,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';

/**
 * The person (R001, R008).
 *
 * One document per human, carrying exactly one role - the role is a single
 * enum, not a list, so "which role is this person" has one answer and the
 * permission middleware has nothing to disambiguate.
 *
 * `passwordHash` is `select: false`. A query has to ask for it explicitly
 * (`findOne(...).select('+passwordHash')`), which means a stray `User.find()`
 * cannot leak a hash into a response body by accident (R011).
 *
 * Indexing note (R012): the directory in S03 filters on `role` and `active`, so
 * those two are indexed together; `email` and `username` are unique because
 * sign-in looks a person up by email and the profile URL uses the username.
 */

const profileSchema = new Schema(
  {
    fullName: { type: String, trim: true, default: '' },
    department: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    bio: { type: String, trim: true, default: '', maxlength: 2000 },
    pictureUrl: { type: String, trim: true, default: null },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
      trim: true,
    },
    username: { type: String, required: true, unique: true, index: true, trim: true },
    /** bcrypt digest only; never the plaintext, never returned by a query unless asked for. */
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, required: true, default: 'developer' },
    /** Reference to a dynamic custom role if the user was assigned a custom role */
    customRoleId: { type: Schema.Types.ObjectId, ref: 'CustomRole', default: null, index: true },
    active: { type: Boolean, required: true, default: true },
    /** Set for the seeded administrator so the first sign-in forces a real password (R008). */
    mustChangePassword: { type: Boolean, required: true, default: false },
    profile: { type: profileSchema, default: () => ({}) },
    lastLoginAt: { type: Date, default: null },
    /**
     * Consecutive failed sign-ins since the last success (R015). Reset to 0 on
     * every successful sign-in, so a person who mistypes once a week never
     * accumulates a lockout.
     */
    failedLoginAttempts: { type: Number, required: true, default: 0, min: 0 },
    /**
     * When the account is barred from signing in, or null. A single-field index
     * is enough: sign-in already loads the person by `email`, so this column is
     * only ever read off a document already in hand (and swept by support).
     */
    lockedUntil: { type: Date, default: null, index: true },
    /**
     * The Google subject recorded on the first Google sign-in (R013). It is
     * deliberately not unique and not the matching key - the address is - so a
     * person who already has a password account lands in that same account
     * rather than a second one keyed on a provider identity.
     */
    googleId: { type: String, trim: true, default: null },
    /** The person's direct manager in the organization tree (S05). */
    managerId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    /** User classification: staff (internal) or client (external tenant). */
    kind: { type: String, enum: ['staff', 'client'], default: 'staff', index: true },
    /** The client ID if this user represents a client organisation. */
    clientId: { type: String, trim: true, default: null, index: true },
    /** The project IDs this client or staff user is scoped to. */
    projectIds: [{ type: Schema.Types.ObjectId, ref: 'Project' }],
  },
  { timestamps: true },
);

// The directory filters on role and active, and department
userSchema.index({ role: 1, active: 1 });
userSchema.index({ roleId: 1 });
userSchema.index({ 'profile.department': 1 });
userSchema.index({ kind: 1, clientId: 1 });

export type UserAttributes = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<UserAttributes>;

/** Reused across reloads and test files so tsx watch cannot register the model twice. */
export const User: Model<UserAttributes> =
  (mongoose.models.User as Model<UserAttributes> | undefined) ?? model<UserAttributes>('User', userSchema);
