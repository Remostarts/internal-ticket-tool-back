import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnect } from '../src/db/connect.js';
import { logger } from '../src/logging/logger.js';
import { AUDIT_ACTIONS, AuditLog } from '../src/models/audit-log.js';
import { writeAudit } from '../src/services/audit.js';
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from './helpers/test-db.js';

/**
 * The audit trail (R009) and its indexes (R012).
 *
 * Two properties matter here. Records carry actor, action, timestamp, resource
 * and details. And an audit failure is invisible to the caller: a write that
 * cannot happen is logged at error level and swallowed, so it can never cost
 * somebody a sign-in.
 *
 * The suite runs in order: the disconnected case comes last because it takes the
 * connection away, and it reconnects to prove the skipped write really left no
 * record behind.
 */

beforeAll(async () => {
  await startTestDatabase();
  await resetTestDatabase();
});

afterAll(async () => {
  await stopTestDatabase();
});

describe('the audit store', () => {
  it('indexes every field the trail filters or sorts on', async () => {
    const indexes = await AuditLog.collection.indexes();
    const names = indexes.map((index) => index.name);

    expect(names).toContain('user_1_timestamp_-1');
    expect(names).toContain('action_1_timestamp_-1');
    expect(names).toContain('timestamp_-1');
  });

  it('records actor, action, timestamp, resource and details', async () => {
    const actorId = new Types.ObjectId();

    await writeAudit({
      userId: actorId,
      action: AUDIT_ACTIONS.LOGIN,
      resourceType: 'user',
      resourceId: actorId.toHexString(),
      details: { method: 'password' },
    });

    const record = await AuditLog.findOne({ action: AUDIT_ACTIONS.LOGIN }).lean();
    expect(record).not.toBeNull();
    expect(record?.user?.toHexString()).toBe(actorId.toHexString());
    expect(record?.timestamp).toBeInstanceOf(Date);
    expect(record?.resourceType).toBe('user');
    expect(record?.resourceId).toBe(actorId.toHexString());
    expect(record?.details).toEqual({ method: 'password' });
  });

  it('accepts a failed sign-in with no actor and no resource', async () => {
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      details: { email: 'nobody@claimdesk.test' },
    });

    const record = await AuditLog.findOne({ action: AUDIT_ACTIONS.LOGIN_FAILED }).lean();
    expect(record).not.toBeNull();
    expect(record?.user ?? null).toBeNull();
    expect(record?.resourceType ?? null).toBeNull();
    expect(record?.details).toEqual({ email: 'nobody@claimdesk.test' });
  });

  it('accepts a user id as a string, as a route handler will hold it', async () => {
    const actorId = new Types.ObjectId();

    await writeAudit({ userId: actorId.toHexString(), action: AUDIT_ACTIONS.PERMISSION_DENIED });

    const record = await AuditLog.findOne({ action: AUDIT_ACTIONS.PERMISSION_DENIED }).lean();
    expect(record?.user?.toHexString()).toBe(actorId.toHexString());
  });
});

describe('the audit writer never breaks its caller', () => {
  it('swallows a failing write and logs it at error level', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    const failingCreate = (() =>
      Promise.reject(new Error('audit store unavailable'))) as unknown as typeof AuditLog.create;
    const createSpy = vi.spyOn(AuditLog, 'create').mockImplementation(failingCreate);

    await expect(writeAudit({ action: AUDIT_ACTIONS.LOGOUT })).resolves.toBeUndefined();

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.LOGOUT }),
      'audit record not written',
    );
  });

  it('skips the write, without stalling, when the database is unreachable', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    await disconnect();

    const startedAt = Date.now();
    await expect(
      writeAudit({ action: AUDIT_ACTIONS.PERMISSION_DENIED, details: { permission: 'audit:read' } }),
    ).resolves.toBeUndefined();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2_000);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.PERMISSION_DENIED, database: 'disconnected' }),
      expect.stringContaining('database unavailable'),
    );

    // Reconnect and prove the skipped write left no record behind.
    await startTestDatabase();
    const written = await AuditLog.countDocuments({ details: { permission: 'audit:read' } });
    expect(written).toBe(0);
  });
});
