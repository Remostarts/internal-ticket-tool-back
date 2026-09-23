import { createHash } from 'node:crypto';
import mongoose, {
  Schema,
  model,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';

/**
 * The password-reset token (R014).
 *
 * A reset link is a single-use bearer credential: whoever holds it can set a new
 * password for the account it names. Only the SHA-256 digest of that credential
 * is stored here - the raw token exists in exactly two places, the email that
 * was sent and the browser that followed the link, and never in the database, a
 * log line or a response body.
 *
 * `expiresAt` carries a TTL index, so a reset request that is never used is
 * reaped by MongoDB instead of becoming a permanent key to the account. `usedAt`
 * is the other half of single-use: the route marks it when it consumes the
 * token, so a replayed link finds a token that is already spent even before the
 * TTL monitor runs.
 *
 * Indexing note (R012): the only lookup is "token from the link", so `tokenHash`
 * is unique and indexed; `user` is indexed for "invalidate every outstanding
 * request for this account" when a password is finally changed.
 */

const passwordResetTokenSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    requestedIp: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

// The deadline: MongoDB removes the document once it passes. TTL has one-second
// resolution, so the route still checks `expiresAt` itself rather than trusting
// the monitor to have run.
passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type PasswordResetTokenAttributes = InferSchemaType<typeof passwordResetTokenSchema>;
export type PasswordResetTokenDocument = HydratedDocument<PasswordResetTokenAttributes>;

/** The stored form of a reset token. The raw token exists only in the email link. */
export function hashResetToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Reused across reloads and test files so tsx watch cannot register the model twice. */
export const PasswordResetToken: Model<PasswordResetTokenAttributes> =
  (mongoose.models.PasswordResetToken as Model<PasswordResetTokenAttributes> | undefined) ??
  model<PasswordResetTokenAttributes>('PasswordResetToken', passwordResetTokenSchema);
