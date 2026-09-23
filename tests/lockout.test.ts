import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_MESSAGES } from '@/shared';
import { createApp } from '../src/app.js';
import { logger } from '../src/logging/logger.js';
import { AUDIT_ACTIONS, AuditLog } from '../src/models/audit-log.js';
import { Session } from '../src/models/session.js';
import { User, type UserDocument } from '../src/models/user.js';
import {
  clearFailedAttempts,
  isLocked,
  lockoutDurationMs,
  lockoutThreshold,
  registerFailedAttempt,
  remainingLockMs,
} from '../src/services/lockout.js';
import { TEST_PASSWORD, createTestUser, sessionCookieHeader, signIn } from './helpers/auth.js';
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from './helpers/test-db.js';

/**
 * The brute-force defences on the sign-in route (R015).
 *
 * Two mechanisms, both exercised through the real application factory - the same
 * middleware stack a browser meets in production, including the shared failure
 * handler - so these cases prove the refusal shape (`code`, `details`,
 * `Retry-After`) as well as the counting:
 *
 *   - the per-account **lock** (`services/lockout.ts`), which the slow guessing
 *     run cannot walk past, and which is therefore the property this file is
 *     named for;
 *   - the per-address **rate limit** on `POST /api/auth/login`, which the fast
 *     flood meets first.
 *
 * The clock is injected everywhere, so no case ever waits for a real lockout
 * minute to pass. Fixtures share one deliberately cheap digest (bcrypt cost 4):
 * the lockout is about counting, and paying cost-12 for every one of the dozens
 * of refused attempts would only make the suite slow, not more convincing. A
 * successful sign-in still upgrades that digest to cost 12 on the way through,
 * which is the production path.
 *
 * **The lock covers the password path only.** `tests/google-auth.test.ts` (T05)
 * signs a *locked* account in through the Google route to prove an attacker who
 * knows an address cannot lock its owner out of the credential they actually
 * use. That expectation starts here: nothing in `services/lockout.ts` touches
 * `active`, `googleId` or any provider state.
 */

const BASE_TIME = new Date('2026-03-01T09:00:00.000Z');
const UNKNOWN_EMAIL = 'lockout-nobody@claimdesk.test';

let clock: Date;
let app: Express;
/** One cheap digest, reused by every fixture so only the sign-in compare costs anything. */
let sharedDigest: string;

beforeAll(async () => {
  await startTestDatabase();
  await resetTestDatabase();

  const seed = await createTestUser({
    email: 'lockout-seed@claimdesk.test',
    username: 'lockout-seed',
    passwordCost: 4,
  });
  sharedDigest = seed.passwordHash;

  // The sign-in limiter is disabled for the lockout cases: several of them make
  // more requests than a sensible window would allow, and a 429 from the window
  // would hide the 429 from the lock the case is about. The limiter gets its own
  // app, and its own cases, in the last describe.
  app = createApp({ auth: { now: () => clock, loginRateLimit: false } });
});

beforeEach(() => {
  clock = new Date(BASE_TIME.getTime());
});

afterAll(async () => {
  await stopTestDatabase();
});

async function fixtureUser(email: string, username: string): Promise<UserDocument> {
  return createTestUser({ email, username, digest: sharedDigest });
}

/** Drives an account to the lock by failing the password the threshold number of times. */
async function lockAccount(user: UserDocument, target: Express = app): Promise<void> {
  for (let attempt = 1; attempt <= lockoutThreshold(); attempt += 1) {
    const refused = await signIn(target, user.email, 'not-the-password');
    expect(refused.status).toBe(401);
  }
  const reloaded = await User.findById(user._id);
  expect(reloaded?.lockedUntil).toBeInstanceOf(Date);
}

describe('the lockout helpers (R015)', () => {
  it('treats the deadline as exclusive: locked before it, free at it', () => {
    const before = new Date(BASE_TIME.getTime() + 60_000);
    const user = { failedLoginAttempts: 0, lockedUntil: before };

    expect(isLocked(user, BASE_TIME)).toBe(true);
    expect(isLocked(user, new Date(before.getTime() - 1))).toBe(true);
    expect(isLocked(user, before)).toBe(false);
    expect(isLocked(user, new Date(before.getTime() + 1))).toBe(false);

    expect(isLocked({ failedLoginAttempts: 0, lockedUntil: null }, BASE_TIME)).toBe(false);
    expect(isLocked({ failedLoginAttempts: 0 }, BASE_TIME)).toBe(false);

    expect(remainingLockMs(user, BASE_TIME)).toBe(60_000);
    expect(remainingLockMs(user, before)).toBe(0);
  });

  it('counts one at a time below the threshold and never sets a deadline early', () => {
    const user = { failedLoginAttempts: 0, lockedUntil: null as Date | null };

    for (let attempt = 1; attempt < lockoutThreshold(); attempt += 1) {
      const outcome = registerFailedAttempt(user, BASE_TIME);
      expect(outcome.locked).toBe(false);
      expect(outcome.attempts).toBe(attempt);
      expect(outcome.lockedUntil).toBeNull();
      expect(user.lockedUntil).toBeNull();
    }
    expect(user.failedLoginAttempts).toBe(lockoutThreshold() - 1);
  });

  it('sets the deadline at the threshold and starts the next window from zero', () => {
    const user = { failedLoginAttempts: lockoutThreshold() - 1, lockedUntil: null as Date | null };

    const outcome = registerFailedAttempt(user, BASE_TIME);

    expect(outcome.locked).toBe(true);
    expect(outcome.attempts).toBe(lockoutThreshold());
    expect(outcome.lockedUntil?.getTime()).toBe(BASE_TIME.getTime() + lockoutDurationMs());
    expect(user.lockedUntil?.getTime()).toBe(BASE_TIME.getTime() + lockoutDurationMs());
    expect(user.failedLoginAttempts).toBe(0);
  });

  it('clears both the counter and an elapsed deadline', () => {
    const user = {
      failedLoginAttempts: 3,
      lockedUntil: new Date(BASE_TIME.getTime() + 1_000),
    };

    clearFailedAttempts(user);

    expect(user.failedLoginAttempts).toBe(0);
    expect(user.lockedUntil).toBeNull();
  });
});

describe('the account lock on POST /api/auth/login', () => {
  it('leaves the account usable below the threshold, and a success clears the counter', async () => {
    const user = await fixtureUser('lockout-below@claimdesk.test', 'lockout-below');

    for (let attempt = 1; attempt < lockoutThreshold(); attempt += 1) {
      const refused = await signIn(app, user.email, 'not-the-password');
      expect(refused.status).toBe(401);
      expect(refused.body).toEqual({
        code: 'INVALID_CREDENTIALS',
        message: ERROR_MESSAGES.INVALID_CREDENTIALS,
      });
      // No limiter was involved: this refusal is the credential path's own.
      expect(refused.body.details?.limit).toBeUndefined();
    }

    const midway = await User.findById(user._id);
    expect(midway?.failedLoginAttempts).toBe(lockoutThreshold() - 1);
    expect(midway?.lockedUntil).toBeNull();

    // One failure short of the threshold is still a working account.
    const accepted = await signIn(app, user.email, TEST_PASSWORD);
    expect(accepted.status).toBe(200);
    expect(sessionCookieHeader(accepted)).not.toBeNull();

    const after = await User.findById(user._id);
    expect(after?.failedLoginAttempts).toBe(0);
    expect(after?.lockedUntil).toBeNull();
  });

  it('locks on the threshold-th failure, and keeps the refusal itself identical', async () => {
    const user = await fixtureUser('lockout-trigger@claimdesk.test', 'lockout-trigger');

    let lastRefusal: request.Response | null = null;
    for (let attempt = 1; attempt <= lockoutThreshold(); attempt += 1) {
      lastRefusal = await signIn(app, user.email, 'not-the-password');
      expect(lastRefusal.status).toBe(401);
    }

    // The attempt that locks still answers like any other wrong password: the
    // lock is only disclosed to somebody who submits the *correct* password.
    expect(lastRefusal?.body).toEqual({
      code: 'INVALID_CREDENTIALS',
      message: ERROR_MESSAGES.INVALID_CREDENTIALS,
    });

    const reloaded = await User.findById(user._id);
    expect(reloaded?.lockedUntil).toBeInstanceOf(Date);
    expect(reloaded?.lockedUntil?.getTime()).toBe(clock.getTime() + lockoutDurationMs());
    // The counter restarts, so the window after the lock begins clean.
    expect(reloaded?.failedLoginAttempts).toBe(0);

    const lockEntry = await AuditLog.findOne({
      action: AUDIT_ACTIONS.ACCOUNT_LOCKED,
      user: user._id,
    }).lean();
    expect(lockEntry).not.toBeNull();
    expect(lockEntry?.details).toMatchObject({ attempts: lockoutThreshold() });

    const failedEntries = await AuditLog.find({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      user: user._id,
    }).lean();
    expect(failedEntries).toHaveLength(lockoutThreshold());
    expect(failedEntries.every((entry) => entry.details?.reason === 'wrong_password')).toBe(true);
  });

  it('refuses even the correct password while locked, and lets it through after the deadline', async () => {
    const user = await fixtureUser('lockout-deadline@claimdesk.test', 'lockout-deadline');
    await lockAccount(user);

    const refused = await signIn(app, user.email, TEST_PASSWORD);
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('RATE_LIMITED');
    expect(refused.body.message).toMatch(/Too many failed sign-in attempts\./);
    expect(refused.body.message).toMatch(/about \d+ more minute/);
    expect(refused.body.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.headers['retry-after']).toBe(String(refused.body.details.retryAfterSeconds));
    expect(sessionCookieHeader(refused)).toBeNull();
    expect(await Session.countDocuments({ user: user._id })).toBe(0);

    // The locked attempt is on the record with its own reason, so an operator
    // can tell "they kept knocking" from "they guessed wrong".
    const lockedEntry = await AuditLog.findOne({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      user: user._id,
      'details.reason': 'locked',
    }).lean();
    expect(lockedEntry).not.toBeNull();

    // A *wrong* password while locked is still refused at the lock, before any
    // comparison: if the password branch had run, this attempt would have
    // incremented the counter. It stays at zero, which is what "no bcrypt work
    // for a locked account" looks like from outside.
    const stillLocked = await signIn(app, user.email, 'not-the-password');
    expect(stillLocked.status).toBe(429);
    expect((await User.findById(user._id))?.failedLoginAttempts).toBe(0);

    // Push the injected clock past the deadline: the same password now works,
    // and the elapsed lock is cleared off the document.
    clock = new Date(clock.getTime() + lockoutDurationMs() + 1_000);

    const accepted = await signIn(app, user.email, TEST_PASSWORD);
    expect(accepted.status).toBe(200);
    expect(sessionCookieHeader(accepted)).not.toBeNull();

    const after = await User.findById(user._id);
    expect(after?.lockedUntil).toBeNull();
    expect(after?.failedLoginAttempts).toBe(0);
  });

  it('logs a warn line naming the account and the wait, without leaking anything else', async () => {
    const user = await fixtureUser('lockout-logged@claimdesk.test', 'lockout-logged');
    await lockAccount(user);

    // The lock log line is an operator surface, so it has to name the account
    // and the wait - and it must not carry the password that was submitted.
    const lines: string[] = [];
    const spy = vi.spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
    try {
      const refused = await signIn(app, user.email, TEST_PASSWORD);
      expect(refused.status).toBe(429);
    } finally {
      spy.mockRestore();
    }

    const joined = lines.join('\n');
    expect(joined).toContain('account is locked');
    expect(joined).toContain(String(user._id));
    expect(joined).not.toContain(TEST_PASSWORD);
    expect(joined).not.toContain('$2b$');
  });

  it('creates no lock and no user document for an address that does not exist', async () => {
    for (let attempt = 1; attempt <= lockoutThreshold() + 2; attempt += 1) {
      const refused = await signIn(app, UNKNOWN_EMAIL, TEST_PASSWORD);
      expect(refused.status).toBe(401);
      expect(refused.body).toEqual({
        code: 'INVALID_CREDENTIALS',
        message: ERROR_MESSAGES.INVALID_CREDENTIALS,
      });
    }

    expect(await User.countDocuments({ email: UNKNOWN_EMAIL })).toBe(0);
    // An unknown address has no actor, so a lock entry with no user could only
    // have come from locking a document that should never have existed.
    expect(await AuditLog.countDocuments({ action: AUDIT_ACTIONS.ACCOUNT_LOCKED, user: null })).toBe(0);
  });

  it('keeps a lock from touching anything another credential path would use', async () => {
    const user = await fixtureUser('lockout-provider@claimdesk.test', 'lockout-provider');
    await lockAccount(user);

    // The Google path (T05) matches on the address and never consults the lock,
    // so a locked password must not mean a barred account: the document stays
    // active, keeps its provider field free for the first Google sign-in, and
    // keeps a working digest. T05 asserts the other half - a locked account can
    // still sign in with Google.
    const locked = await User.findById(user._id).select('+passwordHash');
    expect(locked?.active).toBe(true);
    expect(locked?.googleId).toBeNull();
    expect(locked?.passwordHash).toBeTruthy();
  });
});

describe('the sign-in rate limit', () => {
  it('refuses the request that spends the window, with the wait in the body and the header', async () => {
    const ms = 1_700_000_000_000;
    const limited = createApp({
      auth: {
        now: () => clock,
        loginRateLimit: { name: 'test-auth-login', windowMs: 60_000, max: 3, now: () => ms, trustProxy: true },
      },
    });
    const user = await fixtureUser('lockout-limited@claimdesk.test', 'lockout-limited');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await signIn(limited, user.email, 'not-the-password')).status).toBe(401);
    }

    const refused = await signIn(limited, user.email, 'not-the-password');
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('RATE_LIMITED');
    expect(refused.body.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.body.details.limit).toBe('test-auth-login');
    expect(refused.headers['retry-after']).toBe(String(refused.body.details.retryAfterSeconds));

    // The limiter ran first, so the refused request never reached the account:
    // three failures are recorded, not four.
    const reloaded = await User.findById(user._id);
    expect(reloaded?.failedLoginAttempts).toBe(3);
  });

  it('is removed entirely when loginRateLimit is false', async () => {
    const disabled = createApp({ auth: { now: () => clock, loginRateLimit: false } });
    const user = await fixtureUser('lockout-unlimited@claimdesk.test', 'lockout-unlimited');

    // Four wrong passwords is one past the three-request window above; with the
    // limiter disabled every one of them is the credential refusal.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const refused = await signIn(disabled, user.email, 'not-the-password');
      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe('INVALID_CREDENTIALS');
    }
    expect((await User.findById(user._id))?.failedLoginAttempts).toBe(4);
  });
});
