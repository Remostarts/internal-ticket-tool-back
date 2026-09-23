import { Types } from 'mongoose';
import { AuditLog } from '../models/audit-log.js';
import { databaseState } from '../db/connect.js';
import { logger } from '../logging/logger.js';

/**
 * The audit writer (R009).
 *
 * Writing history must never be able to break the thing it is recording: an
 * audit failure is logged at error level and swallowed, so a full disk or a
 * dropped connection can never cost somebody a sign-in. Callers do not need to
 * wrap this in a try/catch, and they should not - the contract is "this returns
 * without throwing".
 */

export interface WriteAuditInput {
  /** The actor. Null or absent means nobody was signed in (a failed sign-in). */
  userId?: Types.ObjectId | string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  details?: Record<string, unknown>;
}

function normalizeUserId(userId: WriteAuditInput['userId']): Types.ObjectId | null {
  if (!userId) {
    return null;
  }
  if (userId instanceof Types.ObjectId) {
    return userId;
  }
  return Types.ObjectId.isValid(userId) ? new Types.ObjectId(userId) : null;
}

function actorForLog(userId: WriteAuditInput['userId']): string | null {
  if (!userId) {
    return null;
  }
  return userId instanceof Types.ObjectId ? userId.toHexString() : String(userId);
}

export async function writeAudit(input: WriteAuditInput): Promise<void> {
  const userId = actorForLog(input.userId);

  // Mongoose would buffer the write for ten seconds and then fail anyway when
  // the connection is down, which would stall whichever request caused it. Say
  // so immediately instead.
  if (databaseState() !== 'connected') {
    logger.error(
      { action: input.action, userId, database: databaseState() },
      'audit record not written: database unavailable',
    );
    return;
  }

  try {
    await AuditLog.create({
      user: normalizeUserId(input.userId),
      action: input.action,
      timestamp: new Date(),
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      details: input.details ?? {},
    });
  } catch (error) {
    logger.error({ action: input.action, userId, err: error }, 'audit record not written');
  }
}
