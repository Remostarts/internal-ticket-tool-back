import mongoose, {
  Schema,
  model,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';

/**
 * The session (R002).
 *
 * A session is a server-side document, not a self-describing token: the cookie
 * carries 32 random bytes and nothing else, and only the SHA-256 hash of those
 * bytes is stored. That is what makes revocation real - deleting the document
 * ends the session immediately, which a signed JWT cannot do - and it is what
 * lets S02's Google sign-in land in the same session shape instead of inventing
 * a second one.
 *
 * `expiresAt` carries a TTL index, so an abandoned session is reaped by MongoDB
 * rather than living forever because nobody signed out.
 *
 * Indexing note (R012): every request resolves a session by `tokenHash`, so that
 * is unique and indexed; "sign out everywhere" in a later slice reads by `user`.
 */

const sessionSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    lastSeenAt: { type: Date, required: true, default: () => new Date() },
    expiresAt: { type: Date, required: true },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

// The idle-refreshed life: MongoDB removes the document when the deadline passes.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type SessionAttributes = InferSchemaType<typeof sessionSchema>;
export type SessionDocument = HydratedDocument<SessionAttributes>;

/** Reused across reloads and test files so tsx watch cannot register the model twice. */
export const Session: Model<SessionAttributes> =
  (mongoose.models.Session as Model<SessionAttributes> | undefined) ??
  model<SessionAttributes>('Session', sessionSchema);
