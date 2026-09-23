import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgotPasswordSchema, passwordRules, resetPasswordSchema } from '@/shared';
import { PasswordResetToken, hashResetToken } from '../src/models/password-reset-token.js';
import { User, type UserDocument } from '../src/models/user.js';
import { createTestUser } from './helpers/auth.js';
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from './helpers/test-db.js';

/**
 * The password-reset token and the lockout fields it lands in (R014, R015).
 *
 * Three properties are worth more than the rest:
 *
 *   - the collection stores a digest, never the raw token, so a dumped database
 *     is not a pile of working reset links;
 *   - `tokenHash` is unique and `expiresAt` carries a TTL index, so "single use"
 *     and "short-lived" are enforced by the store rather than by careful code;
 *   - a user document defaults to "never failed, never locked, no Google
 *     subject", which is what makes the sign-in route's counters start clean.
 *
 * The fixtures are created once in `beforeAll`; the duplicate-token test expects
 * the earlier document to already exist, so the order inside that block matters.
 */

let subject: UserDocument;

const RESET_TTL_MS = 60 * 60 * 1000;

beforeAll(async () => {
  await startTestDatabase();
  await resetTestDatabase();

  subject = await createTestUser({
    email: 'reset@claimdesk.test',
    username: 'reset',
    fullName: 'Rita Reset',
  });
});

afterAll(async () => {
  await stopTestDatabase();
});

describe('the shared password and reset-token rules', () => {
  it('refuses a password under eight characters', () => {
    expect(passwordRules.safeParse('short12').success).toBe(false);
    expect(passwordRules.safeParse('12345678').success).toBe(true);
  });

  it('counts the 72-byte bcrypt ceiling in bytes, not characters', () => {
    // 'é' is two bytes in UTF-8, so 36 of them already fill bcrypt's window.
    expect(passwordRules.safeParse('é'.repeat(36)).success).toBe(true);
    expect(passwordRules.safeParse('é'.repeat(37)).success).toBe(false);
    expect(passwordRules.safeParse('a'.repeat(72)).success).toBe(true);
    expect(passwordRules.safeParse('a'.repeat(73)).success).toBe(false);
  });

  it('normalises the reset address exactly as sign-in does', () => {
    expect(forgotPasswordSchema.parse({ email: '  Foo@Example.COM ' }).email).toBe(
      'foo@example.com',
    );
    expect(forgotPasswordSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });

  it('refuses a truncated or oversized reset token before any lookup', () => {
    const password = 'correct-horse-battery';

    expect(resetPasswordSchema.safeParse({ token: 'too-short', password }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ token: 'a'.repeat(513), password }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ token: 'a'.repeat(32), password }).success).toBe(true);
    expect(resetPasswordSchema.parse({ token: `  ${'a'.repeat(32)}  `, password }).token).toBe(
      'a'.repeat(32),
    );
  });
});

describe('the password reset token collection', () => {
  it('indexes the token hash uniquely and expires documents by TTL', async () => {
    const indexes = await PasswordResetToken.collection.indexes();
    const byName = new Map(indexes.map((index) => [index.name, index]));

    expect(byName.get('tokenHash_1')?.unique).toBe(true);
    expect(byName.has('user_1')).toBe(true);
    expect(byName.get('expiresAt_1')?.expireAfterSeconds).toBe(0);
  });

  it('hashes deterministically, and the stored document never contains the raw token', async () => {
    const raw = 'a-raw-reset-token-that-must-not-be-persisted';
    const first = hashResetToken(raw);
    const second = hashResetToken(raw);

    expect(first).toBe(second);
    expect(first).not.toBe(raw);
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    const created = await PasswordResetToken.create({
      user: subject._id,
      tokenHash: first,
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
      requestedIp: '203.0.113.7',
    });

    expect(created.usedAt).toBeNull();
    expect(created.requestedIp).toBe('203.0.113.7');
    expect(JSON.stringify(created.toObject())).not.toContain(raw);
  });

  it('stores one digest because it is the lookup key, so a second document is refused', async () => {
    const raw = 'a-duplicate-reset-token-value-for-the-unique-index';

    // The first document may exist: only the second one is the violation.
    await PasswordResetToken.create({
      user: subject._id,
      tokenHash: hashResetToken(raw),
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    });

    await expect(
      PasswordResetToken.create({
        user: subject._id,
        tokenHash: hashResetToken(raw),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('defaults usedAt and requestedIp to null for an unexplained request', async () => {
    const created = await PasswordResetToken.create({
      user: subject._id,
      tokenHash: hashResetToken('a-token-created-with-no-context-at-all'),
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    });

    expect(created.usedAt).toBeNull();
    expect(created.requestedIp).toBeNull();
  });
});

describe('the user lockout and Google fields', () => {
  it('starts a new account unlocked, with no failures and no Google subject', async () => {
    const fresh = await User.findById(subject._id);

    expect(fresh?.failedLoginAttempts).toBe(0);
    expect(fresh?.lockedUntil).toBeNull();
    expect(fresh?.googleId).toBeNull();
  });

  it('round-trips a lock deadline as a real Date, and counts attempts upward', async () => {
    const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);

    await User.updateOne(
      { _id: subject._id },
      { failedLoginAttempts: 6, lockedUntil, googleId: 'google-subject-12345' },
    );

    const reloaded = await User.findById(subject._id);
    expect(reloaded?.failedLoginAttempts).toBe(6);
    expect(reloaded?.lockedUntil).toBeInstanceOf(Date);
    expect(reloaded?.lockedUntil?.getTime()).toBe(lockedUntil.getTime());
    expect(reloaded?.googleId).toBe('google-subject-12345');

    // Clearing the lock is how a successful sign-in gets back in.
    await User.updateOne({ _id: subject._id }, { failedLoginAttempts: 0, lockedUntil: null });
    const unlocked = await User.findById(subject._id);
    expect(unlocked?.failedLoginAttempts).toBe(0);
    expect(unlocked?.lockedUntil).toBeNull();
  });

  it('refuses a negative failure count rather than storing nonsense', async () => {
    await expect(
      User.updateOne({ _id: subject._id }, { failedLoginAttempts: -1 }, { runValidators: true }),
    ).rejects.toThrow(/failedLoginAttempts/);
  });
});
