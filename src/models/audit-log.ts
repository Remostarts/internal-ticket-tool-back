import mongoose, { Schema, model, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

/**
 * The audit trail (R009).
 *
 * Additive history, written from the first slice because early history cannot be
 * backfilled: who did what, to which resource, when, with whatever detail the
 * caller has. Records are never updated or deleted by the application.
 *
 * Indexing note (R012): the Trail screen queries newest-first and filters by
 * actor or by action, so every index here leads with the filter field and ends
 * with `timestamp` in the direction the query sorts.
 */

/** The action names this slice and the next one write. Kept in one place so a call site cannot typo one. */
export const AUDIT_ACTIONS = {
  LOGIN: 'auth.login',
  LOGIN_FAILED: 'auth.login_failed',
  LOGOUT: 'auth.logout',
  PERMISSION_DENIED: 'permission.denied',
  PASSWORD_RESET_REQUESTED: 'auth.password_reset_requested',
  PASSWORD_RESET_COMPLETED: 'auth.password_reset_completed',
  ACCOUNT_LOCKED: 'auth.account_locked',
} as const;

const auditLogSchema = new Schema(
  {
    /** The actor, or null when nobody was signed in (a failed sign-in). */
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, required: true, trim: true },
    timestamp: { type: Date, required: true, default: () => new Date() },
    resourceType: { type: String, default: null },
    resourceId: { type: String, default: null },
    details: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { versionKey: false },
);

auditLogSchema.index({ user: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ timestamp: -1 });

export type AuditLogEntry = InferSchemaType<typeof auditLogSchema>;
export type AuditLogDocument = HydratedDocument<AuditLogEntry>;

/** Reused across reloads and test files so tsx watch cannot register the model twice. */
export const AuditLog: Model<AuditLogEntry> =
  (mongoose.models.AuditLog as Model<AuditLogEntry> | undefined) ??
  model<AuditLogEntry>('AuditLog', auditLogSchema);
