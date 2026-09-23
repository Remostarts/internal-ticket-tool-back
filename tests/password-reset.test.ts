import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ERROR_MESSAGES } from '@/shared';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { logger } from '../src/logging/logger.js';
import { AUDIT_ACTIONS, AuditLog } from '../src/models/audit-log.js';
import { PasswordResetToken, hashResetToken } from '../src/models/password-reset-token.js';
import { Session } from '../src/models/session.js';
import { User, type UserDocument } from '../src/models/user.js';
import { createMailer, maskEmail, type Mailer, type OutboundMail } from '../src/services/mail.js';
import { verifyPassword } from '../src/services/password.js';
import { issueResetToken } from '../src/services/password-reset.js';
import {
  createTestUser,
  signIn,
  signInAs,
  TEST_PASSWORD,
} from './helpers/auth.js';
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from './helpers/test-db.js';

/**
 * Password recovery end to end (R014, R015).
 *
 * The routes are exercised through `createApp`'s real middleware stack - the
 * mailer and the clock are handed in through the factory's `auth` seam, which is
 * the same seam production leaves unset - so what is proved here is the request
 * a browser makes, not a service called directly.
 *
 * The properties worth more than the rest, in the order the suite defends them:
 *
 *   - a known address, an unknown address and a delivery failure leave as the
 *     *identical* 200 body, so the route is not an account-existence oracle;
 *   - the store holds only the digest of a delivered token, and the raw token
 *     reaches no response body, audit detail or log line;
 *   - a token is spent exactly once, expires, and dies with a deactivated
 *     account - every one of those refuses with the same message;
 *   - a successful reset sets a working password and ends every session the
 *     account had open.
 *
 * The rate limiter is proved by wiring rather than by timing: the limited app
 * gets a two-request window, and the third request is refused with the shared
 * 429 shape.
 */

let app: Express;
let rejectingApp: Express;
let unconfiguredApp: Express;
let limitedApp: Express;

/** Mutable clock: the reset service reads it on both issue and consume. */
let clock = new Date();
const now = (): Date => clock;

/** Every message a capturing mailer accepted, cleared by the tests that count. */
let sent: Array<OutboundMail & { id: string }> = [];

const capturingMailer: Mailer = {
  transport: 'outbox',
  async send(mail) {
    const id = `captured-${sent.length + 1}`;
    sent.push({ ...mail, id });
    return { id, transport: 'outbox' };
  },
};

const rejectingMailer: Mailer = {
  transport: 'smtp',
  async send() {
    throw new Error('smtp connection refused');
  },
};

let owner: UserDocument;
let rotator: UserDocument;
let twice: UserDocument;
let expiring: UserDocument;
let inactive: UserDocument;
let sessionHolder: UserDocument;
let leaker: UserDocument;

/** Captures every level of the shared logger, so a leak at any level is visible. */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

  const record = (...args: unknown[]): void => {
    lines.push(
      args
        .map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg)))
        .join(' '),
    );
  };

  const spies = levels.map((level) => {
    const spy = vi.spyOn(logger, level) as unknown as {
      mockImplementation: (fn: (...args: unknown[]) => void) => void;
      mockRestore: () => void;
    };
    spy.mockImplementation(record);
    return spy;
  });

  return {
    lines,
    restore: () => {
      for (const spy of spies) {
        spy.mockRestore();
      }
    },
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** The raw token carried by the link in a delivered message. */
function tokenFromMail(mail: OutboundMail): string {
  const match = /reset-password\?token=([^\s"<]+)/.exec(mail.text);
  if (!match?.[1]) {
    throw new Error(`no reset link in the captured message: ${mail.text}`);
  }
  return decodeURIComponent(match[1]);
}

async function forgot(email: string, target: Express = app): Promise<request.Response> {
  return request(target).post('/api/auth/password/forgot').send({ email });
}

async function reset(token: string, password: string, target: Express = app): Promise<request.Response> {
  return request(target).post('/api/auth/password/reset').send({ token, password });
}

/** Requests a link for `user` and returns the raw token the message carried. */
async function requestTokenFor(user: UserDocument): Promise<string> {
  sent = [];
  const response = await forgot(user.email);
  if (response.status !== 200 || sent.length !== 1 || !sent[0]) {
    throw new Error(`could not obtain a token for ${user.email}: ${response.status} ${response.text}`);
  }
  return tokenFromMail(sent[0]);
}

beforeAll(async () => {
  await startTestDatabase();
  await resetTestDatabase();

  clock = new Date();

  app = createApp({ auth: { mailer: capturingMailer, now, forgotRateLimit: false } });
  rejectingApp = createApp({ auth: { mailer: rejectingMailer, now, forgotRateLimit: false } });
  // A real mailer from the real configuration with no SMTP URL: the transport
  // resolves to 'none', which is the installation the 503 branch exists for.
  unconfiguredApp = createApp({
    auth: { mailer: createMailer({ transport: 'smtp', smtpUrl: '' }), now, forgotRateLimit: false },
  });
  limitedApp = createApp({
    auth: {
      mailer: capturingMailer,
      now,
      forgotRateLimit: { name: 'test-forgot', windowMs: 60_000, max: 2 },
    },
  });

  owner = await createTestUser({ email: 'owner@claimdesk.test', username: 'owner', fullName: 'Olive Owner' });
  rotator = await createTestUser({ email: 'rotator@claimdesk.test', username: 'rotator' });
  twice = await createTestUser({ email: 'twice@claimdesk.test', username: 'twice' });
  expiring = await createTestUser({ email: 'expiring@claimdesk.test', username: 'expiring' });
  inactive = await createTestUser({ email: 'disabled@claimdesk.test', username: 'disabled', active: false });
  sessionHolder = await createTestUser({ email: 'session@claimdesk.test', username: 'sessionuser' });
  leaker = await createTestUser({ email: 'leaker@claimdesk.test', username: 'leaker' });
});

afterEach(() => {
  sent = [];
});

afterAll(async () => {
  await stopTestDatabase();
});

describe('POST /api/auth/password/forgot', () => {
  it('answers 200 and mails exactly one link for a known, active address', async () => {
    sent = [];
    const response = await forgot(owner.email);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ requested: true });
    expect(sent).toHaveLength(1);

    const mail = sent[0]!;
    expect(mail.to).toBe(owner.email);
    expect(mail.text).toContain(`${env.WEB_ORIGIN.replace(/\/+$/, '')}/reset-password?token=`);
    expect(mail.subject).toBe('Reset your Claim Desk password');
    expect(mail.html).toContain('/reset-password?token=');
  });

  it('answers the identical status and body for an unknown address, and mails nothing', async () => {
    sent = [];
    const known = await forgot(owner.email);
    const mailsAfterKnown = sent.length;

    const unknown = await forgot('nobody-at-all@claimdesk.test');

    expect(mailsAfterKnown).toBe(1);
    expect(sent).toHaveLength(1);
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(unknown.body).toEqual({ requested: true });
  });

  it('also answers the identical 200 when the mailer rejects, and logs the failure at error level', async () => {
    const logs = captureLogs();
    try {
      const response = await forgot(owner.email, rejectingApp);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ requested: true });
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(logs.lines.some((line) => line.includes('password reset mail could not be sent'))).toBe(true);
      expect(response.text).not.toContain('smtp connection refused');
    } finally {
      logs.restore();
    }
  });

  it('refuses plainly when no mail transport is configured, before any lookup', async () => {
    const logs = captureLogs();
    let response: request.Response;
    try {
      response = await forgot('nobody-at-all@claimdesk.test', unconfiguredApp);
    } finally {
      logs.restore();
    }

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: 'MAIL_NOT_CONFIGURED',
      message: ERROR_MESSAGES.MAIL_NOT_CONFIGURED,
    });
  });

  it('enforces the forgot limit as a middleware in front of the route', async () => {
    const first = await forgot(owner.email, limitedApp);
    const second = await forgot(owner.email, limitedApp);
    const third = await forgot(owner.email, limitedApp);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('RATE_LIMITED');
    expect(third.body.details.limit).toBe('test-forgot');
    expect(third.headers['retry-after']).toBeDefined();
  });

  it('never mails, logs or audits a raw token, and identifies the request by masked address only', async () => {
    const logs = captureLogs();
    sent = [];
    let rawToken = '';
    let responseBody = '';
    let forgotBody = '';
    try {
      const response = await forgot(leaker.email);
      forgotBody = response.text;
      rawToken = tokenFromMail(sent[0]!);
      const resetResponse = await reset(rawToken, 'a-whole-new-password-1');
      responseBody = resetResponse.text;
    } finally {
      logs.restore();
    }

    expect(forgotBody).not.toContain(rawToken);
    expect(responseBody).not.toContain(rawToken);

    const audits = await AuditLog.find({
      action: { $in: [AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED, AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED] },
    });
    expect(JSON.stringify(audits.map((entry) => entry.toObject()))).not.toContain(rawToken);

    const completed = audits.find((entry) => entry.action === AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED);
    const prefix = (completed?.details as { tokenHashPrefix?: string } | undefined)?.tokenHashPrefix;
    expect(prefix).toHaveLength(8);
    expect(rawToken).not.toContain(prefix);

    const masked = maskEmail(leaker.email);
    const joined = logs.lines.join('\n');
    expect(joined).not.toContain(rawToken);
    expect(joined).not.toContain(leaker.email);
    expect(joined).toContain(masked);
  });
});

describe('the delivered token and the store', () => {
  it('stores only the digest, so the raw token exists in the mail and nowhere else', async () => {
    const raw = await requestTokenFor(owner);

    // `owner` has older documents from the tests above, so the proof is about
    // the one this link produced: a document whose digest matches, holding no
    // copy of the raw value anywhere.
    const documents = await PasswordResetToken.find({ user: owner._id });
    const stored = documents.find((document) => document.tokenHash === hashResetToken(raw));
    expect(stored).toBeDefined();
    expect(stored?.usedAt).toBeNull();
    expect(JSON.stringify(documents.map((document) => document.toObject()))).not.toContain(raw);
  });

  it('supersedes an earlier unused link when a second one is requested', async () => {
    const first = await requestTokenFor(owner);
    const second = await requestTokenFor(owner);

    expect(first).not.toBe(second);
    expect(await PasswordResetToken.countDocuments({ user: owner._id, usedAt: null })).toBe(1);

    // The superseded link is dead, so the second request did not leave two
    // working links in the mailbox.
    const refused = await reset(first, 'the-first-link-must-be-dead');
    expect(refused.status).toBe(400);
  });
});

describe('POST /api/auth/password/reset', () => {
  it('sets the new password, which then signs in, and clears the reset flags', async () => {
    const raw = await requestTokenFor(rotator);
    const newPassword = 'a-brand-new-password-1';

    const response = await reset(raw, newPassword);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ reset: true });

    const reloaded = await User.findById(rotator._id).select('+passwordHash');
    expect(await verifyPassword(newPassword, reloaded?.passwordHash)).toBe(true);
    expect(await verifyPassword(TEST_PASSWORD, reloaded?.passwordHash)).toBe(false);
    expect(reloaded?.mustChangePassword).toBe(false);
    expect(reloaded?.failedLoginAttempts).toBe(0);
    expect(reloaded?.lockedUntil).toBeNull();

    const login = await signIn(app, rotator.email, newPassword);
    expect(login.status).toBe(200);
  });

  it('refuses the same link a second time with one identical message', async () => {
    const raw = await requestTokenFor(twice);

    const first = await reset(raw, 'a-password-for-the-first-use');
    expect(first.status).toBe(200);

    const second = await reset(raw, 'a-password-for-the-second-use');
    expect(second.status).toBe(400);
    expect(second.body.code).toBe('VALIDATION_FAILED');
    expect(second.body.message).toBe('That password reset link is no longer valid. Request a new one.');
    expect(second.body.details.fields).toEqual([
      { path: 'token', message: 'That password reset link is no longer valid. Request a new one.' },
    ]);
  });

  it('refuses a token whose deadline has passed', async () => {
    const raw = await requestTokenFor(expiring);

    // Move the injected clock past the link's lifetime. The document is still
    // present (the TTL monitor has not run), so this is the route's own check.
    clock = new Date(clock.getTime() + (env.RESET_TOKEN_MINUTES + 1) * 60_000);

    const response = await reset(raw, 'too-late-for-this-link');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    // The refusal came from the deadline, not from a spend: the document is
    // still there and still unused, so the route checked `expiresAt` itself
    // rather than trusting the TTL monitor to have run.
    const documents = await PasswordResetToken.find({ user: expiring._id });
    expect(documents).toHaveLength(1);
    expect(documents[0]?.usedAt).toBeNull();
  });

  it('refuses a token that names a deactivated account, with the same message', async () => {
    const { rawToken } = await issueResetToken({ userId: String(inactive._id), now: clock });

    const response = await reset(rawToken, 'no-account-to-set-this-on');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.message).toBe('That password reset link is no longer valid. Request a new one.');
  });

  it('refuses an unknown or malformed token with the field refusal, not a 500', async () => {
    const unknown = await reset('a'.repeat(43), 'a-password-that-does-not-matter');
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('VALIDATION_FAILED');
    expect(unknown.body.details.fields[0].path).toBe('token');

    const tooShort = await request(app)
      .post('/api/auth/password/reset')
      .send({ token: 'short', password: 'a-password-that-does-not-matter' });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.code).toBe('VALIDATION_FAILED');
    expect(tooShort.body.details.fields[0].path).toBe('token');
  });

  it('revokes every session the account had open before the reset', async () => {
    const signedIn = await signInAs(app, sessionHolder.email);
    const before = await request(app).get('/api/auth/me').set('Cookie', signedIn.cookie);
    expect(before.status).toBe(200);

    const raw = await requestTokenFor(sessionHolder);
    const resetResponse = await reset(raw, 'the-password-after-the-reset');
    expect(resetResponse.status).toBe(200);

    const after = await request(app).get('/api/auth/me').set('Cookie', signedIn.cookie);
    expect(after.status).toBe(401);
    expect(await Session.countDocuments({ user: sessionHolder._id })).toBe(0);
  });
});

