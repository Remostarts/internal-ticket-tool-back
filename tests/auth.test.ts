import request from 'supertest';
import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ERROR_MESSAGES, permissionsForRole, ALL_PERMISSIONS } from '@/shared';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { disconnect } from '../src/db/connect.js';
import { logger } from '../src/logging/logger.js';
import { AUDIT_ACTIONS, AuditLog } from '../src/models/audit-log.js';
import { Session } from '../src/models/session.js';
import { Project } from '../src/models/project.js';
import { User, type UserDocument } from '../src/models/user.js';
import { hashPassword, passwordCost, verifyPassword } from '../src/services/password.js';
import {
  assertNotProduction,
  LEGACY_SEED_EMAILS,
  removeLegacyAccounts,
  seedDevelopmentAccounts,
  seedProjects,
  TEAM_ACCOUNTS,
  TEAM_PASSWORD,
  TEAM_PROJECTS,
} from '../src/scripts/seed-dev.js';
import { seedAdmin } from '../src/services/seed-admin.js';
import { hashSessionToken, SESSION_COOKIE_NAME } from '../src/services/session.js';
import {
  createTestUser,
  rawTokenFromCookie,
  sessionCookieHeader,
  signIn,
  signInAs,
  TEST_PASSWORD,
} from './helpers/auth.js';
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from './helpers/test-db.js';

/**
 * Email and password sign-in, the session document behind it, and the seeded
 * administrator (R001, R002, R008).
 *
 * The properties this suite defends, in the order they matter:
 *
 *   - a successful sign-in issues a signed cookie that `GET /api/auth/me`
 *     accepts, and the same call without it is refused;
 *   - an unknown address, a wrong password and a deactivated account are
 *     indistinguishable from outside - same status, same code, same message;
 *   - deactivation and revocation take effect on the *next request*, which is
 *     the whole reason the session is a document rather than a token;
 *   - no response body and no log line carries the password, the digest or the
 *     raw token;
 *   - the administrator seed creates exactly one account and never overwrites a
 *     password that already exists.
 *
 * The suite creates its fixtures once, in `beforeAll`, and mutates them
 * deliberately - several tests assert on state a previous test produced (a
 * deactivation, a revocation), which is why the order inside each block is
 * comment-marked where it matters.
 */

const UNKNOWN_EMAIL = 'nobody@claimdesk.test';

let app: Express;
let developer: UserDocument;
let manager: UserDocument;
let inactive: UserDocument;

beforeAll(async () => {
  await startTestDatabase();
  await resetTestDatabase();

  app = createApp();
  developer = await createTestUser({
    email: 'dev@claimdesk.test',
    username: 'dev',
    role: 'developer',
    fullName: 'Dee Developer',
  });
  manager = await createTestUser({
    email: 'mgr@claimdesk.test',
    username: 'mgr',
    role: 'manager',
    digest: developer.passwordHash,
    fullName: 'Mo Manager',
  });
  inactive = await createTestUser({
    email: 'gone@claimdesk.test',
    username: 'gone',
    active: false,
    digest: developer.passwordHash,
  });
});

afterAll(async () => {
  await stopTestDatabase();
});

/** Captures every level of the shared logger, so a leak in any of them is visible. */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

  const record = (...args: unknown[]): void => {
    lines.push(
      args
        .map((arg) => {
          if (typeof arg === 'string') {
            return arg;
          }
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
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

describe('the user model', () => {
  it('normalises the address, keeps exactly one role, and indexes what later screens filter on', async () => {
    const created = await createTestUser({
      email: 'Lower.Case@ClaimDesk.Test',
      username: 'lowercase',
      role: 'management',
      digest: developer.passwordHash,
    });

    expect(created.email).toBe('lower.case@claimdesk.test');
    expect(created.role).toBe('management');
    expect(created.active).toBe(true);
    expect(created.mustChangePassword).toBe(false);

    const indexes = await User.collection.indexes();
    const byName = new Map(indexes.map((index) => [index.name, index]));
    expect(byName.get('email_1')?.unique).toBe(true);
    expect(byName.get('username_1')?.unique).toBe(true);
    expect(byName.has('role_1_active_1')).toBe(true);
  });

  it('refuses a second account with the same address in different case', async () => {
    await expect(
      User.create({
        email: 'DEV@claimdesk.test',
        username: 'dev-two',
        passwordHash: developer.passwordHash,
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('does not hand the password digest to a query that did not ask for it (R011)', async () => {
    const plain = await User.findOne({ email: developer.email });
    expect(plain?.passwordHash).toBeUndefined();

    const asked = await User.findOne({ email: developer.email }).select('+passwordHash');
    expect(asked?.passwordHash).toMatch(/^\$2[aby]\$12\$/);
  });
});

describe('the session model', () => {
  it('indexes the token hash uniquely and expires documents by TTL', async () => {
    const indexes = await Session.collection.indexes();
    const byName = new Map(indexes.map((index) => [index.name, index]));

    expect(byName.get('tokenHash_1')?.unique).toBe(true);
    expect(byName.has('user_1')).toBe(true);
    expect(byName.get('expiresAt_1')?.expireAfterSeconds).toBe(0);
  });

  it('stores only the hash of the token, never the token', async () => {
    const { cookie } = await signInAs(app, developer.email);
    const rawToken = rawTokenFromCookie(cookie ?? '');

    const stored = await Session.findOne({ tokenHash: hashSessionToken(rawToken) });
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored?.toObject())).not.toContain(rawToken);
    expect(stored?.user.toString()).toBe(String(developer._id));

    await Session.deleteMany({});
  });
});

describe('POST /api/auth/login', () => {
  it('issues a signed httpOnly cookie and answers with the identity, role and permissions', async () => {
    const response = await signIn(app, developer.email);

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
      email: developer.email,
      username: 'dev',
      role: 'developer',
      mustChangePassword: false,
    });
    expect(response.body.user.permissions).toEqual([...permissionsForRole('developer')]);
    expect(response.body.user.profile).toMatchObject({ fullName: 'Dee Developer' });
    expect(typeof response.body.user.lastLoginAt).toBe('string');

    const setCookie = response.headers['set-cookie']?.[0] ?? '';
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=s%3A`));
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toMatch(/Max-Age=\d+/);

    const reloaded = await User.findById(developer._id);
    expect(reloaded?.lastLoginAt).toBeInstanceOf(Date);
  });

  it('accepts that cookie at GET /api/auth/me, and refuses the same call without it', async () => {
    const { cookie, body } = await signInAs(app, manager.email);

    const withCookie = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(withCookie.status).toBe(200);
    expect(withCookie.body.user).toEqual(body.user);
    expect(withCookie.body.user.role).toBe('manager');
    expect(withCookie.body.user.permissions).toEqual([...permissionsForRole('manager')]);

    const withoutCookie = await request(app).get('/api/auth/me');
    expect(withoutCookie.status).toBe(401);
    expect(withoutCookie.body).toEqual({
      code: 'UNAUTHENTICATED',
      message: ERROR_MESSAGES.UNAUTHENTICATED,
    });
  });

  it('answers a wrong password and an unknown address with one identical refusal', async () => {
    const wrongPassword = await signIn(app, developer.email, 'not-the-password');
    const unknownEmail = await signIn(app, UNKNOWN_EMAIL, TEST_PASSWORD);

    for (const response of [wrongPassword, unknownEmail]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        code: 'INVALID_CREDENTIALS',
        message: ERROR_MESSAGES.INVALID_CREDENTIALS,
      });
      expect(sessionCookieHeader(response)).toBeNull();
    }
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.text).toBe(unknownEmail.text);
  });

  it('refuses a deactivated account with the same refusal and no cookie', async () => {
    const response = await signIn(app, inactive.email);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('INVALID_CREDENTIALS');
    expect(response.body.message).toBe(ERROR_MESSAGES.INVALID_CREDENTIALS);
    expect(sessionCookieHeader(response)).toBeNull();
    expect(await Session.countDocuments({ user: inactive._id })).toBe(0);
  });

  it('validates the body with the shared schema rather than a second copy of the rules', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: '' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.details.fields).toContainEqual({
      path: 'email',
      message: 'Enter a valid email address.',
    });
    expect(response.body.details.fields).toContainEqual({
      path: 'password',
      message: 'Enter your password.',
    });
  });

  it('upgrades a digest written at an older cost while it has the plaintext in hand', async () => {
    const legacy = await createTestUser({
      email: 'legacy@claimdesk.test',
      username: 'legacy',
      password: 'legacy-password',
      passwordCost: 10,
    });
    expect(passwordCost(legacy.passwordHash)).toBe(10);

    const response = await signIn(app, legacy.email, 'legacy-password');
    expect(response.status).toBe(200);

    const reloaded = await User.findById(legacy._id).select('+passwordHash');
    expect(passwordCost(reloaded?.passwordHash ?? '')).toBe(12);
    expect(await verifyPassword('legacy-password', reloaded?.passwordHash)).toBe(true);
  });
});

describe('the session gate on GET /api/auth/me', () => {
  it('refuses a cookie whose signature was changed', async () => {
    const { cookie } = await signInAs(app, developer.email);
    const tampered = `${cookie?.slice(0, -1)}${cookie?.endsWith('A') ? 'B' : 'A'}`;

    const response = await request(app).get('/api/auth/me').set('Cookie', tampered ?? '');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a cookie whose token was never issued', async () => {
    const response = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `${SESSION_COOKIE_NAME}=a-token-nobody-minted`);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a session past its deadline and removes the document', async () => {
    const { cookie } = await signInAs(app, developer.email);
    const tokenHash = hashSessionToken(rawTokenFromCookie(cookie ?? ''));

    await Session.updateOne({ tokenHash }, { expiresAt: new Date(Date.now() - 1_000) });

    const response = await request(app).get('/api/auth/me').set('Cookie', cookie ?? '');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    expect(await Session.countDocuments({ tokenHash })).toBe(0);
  });

  it('rolls an idle session forward and re-issues the cookie, but leaves a fresh one alone', async () => {
    const { cookie } = await signInAs(app, developer.email);
    const tokenHash = hashSessionToken(rawTokenFromCookie(cookie ?? ''));
    const twentyDaysOut = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);

    await Session.updateOne(
      { tokenHash },
      { lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000), expiresAt: twentyDaysOut },
    );

    const rolled = await request(app).get('/api/auth/me').set('Cookie', cookie ?? '');
    expect(rolled.status).toBe(200);
    expect(sessionCookieHeader(rolled)).not.toBeNull();

    const afterRoll = await Session.findOne({ tokenHash });
    expect(afterRoll?.expiresAt.getTime()).toBeGreaterThan(twentyDaysOut.getTime());
    expect(Date.now() - (afterRoll?.lastSeenAt.getTime() ?? 0)).toBeLessThan(30_000);

    const steady = await request(app).get('/api/auth/me').set('Cookie', cookie ?? '');
    expect(steady.status).toBe(200);
    expect(steady.headers['set-cookie']).toBeUndefined();

    const afterSteady = await Session.findOne({ tokenHash });
    expect(afterSteady?.expiresAt.getTime()).toBe(afterRoll?.expiresAt.getTime());
  });

  it('revokes the session and refuses the next request when the account is deactivated', async () => {
    const subject = await createTestUser({
      email: 'soon-gone@claimdesk.test',
      username: 'soon-gone',
      digest: developer.passwordHash,
    });

    const { cookie } = await signInAs(app, subject.email);
    const tokenHash = hashSessionToken(rawTokenFromCookie(cookie ?? ''));
    expect(await Session.countDocuments({ tokenHash })).toBe(1);

    await User.updateOne({ _id: subject._id }, { active: false });

    const response = await request(app).get('/api/auth/me').set('Cookie', cookie ?? '');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    // The point of a server-side session: deactivation ends the live session now.
    expect(await Session.countDocuments({ tokenHash })).toBe(0);
  });
});

describe('POST /api/auth/logout', () => {
  it('requires a session', async () => {
    const response = await request(app).post('/api/auth/logout');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('revokes the session, clears the cookie and refuses the old cookie afterwards', async () => {
    const { cookie } = await signInAs(app, developer.email);
    const tokenHash = hashSessionToken(rawTokenFromCookie(cookie ?? ''));

    const response = await request(app).post('/api/auth/logout').set('Cookie', cookie ?? '');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ signedOut: true });

    const cleared = ([] as string[])
      .concat(response.headers['set-cookie'] ?? [])
      .find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);

    expect(await Session.countDocuments({ tokenHash })).toBe(0);

    const afterLogout = await request(app).get('/api/auth/me').set('Cookie', cookie ?? '');
    expect(afterLogout.status).toBe(401);
    expect(afterLogout.text).not.toContain('permissions');
  });
});

describe('the audit trail of sign-in', () => {
  it('records a successful sign-in, a refused one and a sign-out against the right actor', async () => {
    const subject = await createTestUser({
      email: 'audited@claimdesk.test',
      username: 'audited',
      digest: developer.passwordHash,
    });

    const { cookie } = await signInAs(app, subject.email);
    await signIn(app, subject.email, 'wrong-password');
    await request(app).post('/api/auth/logout').set('Cookie', cookie ?? '');

    const actions = (await AuditLog.find({ user: subject._id }).sort({ timestamp: 1 }).lean()).map(
      (entry) => entry.action,
    );
    expect(actions).toEqual([AUDIT_ACTIONS.LOGIN, AUDIT_ACTIONS.LOGIN_FAILED, AUDIT_ACTIONS.LOGOUT]);

    const refused = await AuditLog.findOne({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      user: subject._id,
    }).lean();
    expect(refused?.details).toMatchObject({ method: 'password', reason: 'wrong_password' });

    // An unknown address has no actor, but the attempt is still visible.
    await signIn(app, 'audited-nobody@claimdesk.test', TEST_PASSWORD);
    const anonymous = await AuditLog.findOne({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      user: null,
    }).lean();
    expect(anonymous?.details).toMatchObject({ reason: 'unknown_email' });
  });
});

describe('secrets stay out of responses and logs', () => {
  it('never writes the password, its digest or the raw token to a body or a log line', async () => {
    const subject = await createTestUser({
      email: 'quiet@claimdesk.test',
      username: 'quiet',
      password: 'a-password-nobody-should-log',
    });
    const digest = subject.passwordHash;

    const capture = captureLogs();
    try {
      const login = await signIn(app, subject.email, 'a-password-nobody-should-log');
      const cookie = sessionCookieHeader(login);
      const rawToken = rawTokenFromCookie(cookie ?? '');

      const me = await request(app).get('/api/auth/me').set('Cookie', cookie ?? '');
      const logout = await request(app).post('/api/auth/logout').set('Cookie', cookie ?? '');
      const refused = await signIn(app, subject.email, 'a-password-nobody-should-log-but-wrong');

      const bodies = [login.text, me.text, logout.text, refused.text].join('\n');
      const logs = capture.lines.join('\n');

      expect(rawToken.length).toBeGreaterThan(20);
      for (const haystack of [bodies, logs]) {
        expect(haystack).not.toContain('a-password-nobody-should-log');
        expect(haystack).not.toContain(digest);
        expect(haystack).not.toContain(rawToken);
        expect(haystack).not.toContain('$2b$');
      }

      // The log is not empty, so "nothing leaked" is not "nothing was written".
      expect(logs).toContain('sign-in refused');
    } finally {
      capture.restore();
    }
  });
});

describe('the administrator seed on boot', () => {
  it('creates exactly one administrator that can sign in, and never touches it again', async () => {
    const first = await seedAdmin();
    expect(first.created).toBe(true);
    expect(first.email).toBe(env.SEED_ADMIN_EMAIL);

    const admins = await User.find({ role: 'admin' }).select('+passwordHash');
    expect(admins).toHaveLength(1);
    const admin = admins[0];
    expect(admin?.email).toBe(env.SEED_ADMIN_EMAIL);
    expect(admin?.mustChangePassword).toBe(true);
    expect(admin?.profile?.fullName).toBe(env.SEED_ADMIN_NAME);
    expect(await verifyPassword(env.SEED_ADMIN_PASSWORD, admin?.passwordHash)).toBe(true);

    // The configured password really is the way in.
    const signedIn = await signInAs(app, env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_PASSWORD);
    expect(signedIn.body.user.role).toBe('admin');
    expect(signedIn.body.user.mustChangePassword).toBe(true);
    expect(signedIn.body.user.permissions).toHaveLength(ALL_PERMISSIONS.length);

    // A second boot leaves the account alone, password included.
    const digestBefore = admin?.passwordHash;
    const second = await seedAdmin();
    expect(second.created).toBe(false);
    expect(second.reason).toBe('already_exists');
    expect(await User.countDocuments({ role: 'admin' })).toBe(1);

    const after = await User.findById(admin?._id).select('+passwordHash');
    expect(after?.passwordHash).toBe(digestBefore);
  });

  it('seeds the team accounts once and leaves an existing one alone', async () => {
    const first = await seedDevelopmentAccounts();
    expect(first.created).toHaveLength(TEAM_ACCOUNTS.length);
    expect(first.admin.created).toBe(false); // the administrator already exists by now

    const developerAccount = TEAM_ACCOUNTS.find((account) => account.role === 'developer');
    const account = await User.findOne({ email: developerAccount?.email });
    expect(account?.role).toBe('developer');
    expect(account?.active).toBe(true);

    const signedIn = await signInAs(app, developerAccount?.email ?? '', TEAM_PASSWORD);
    expect(signedIn.body.user.permissions).toEqual([...permissionsForRole('developer')]);

    const second = await seedDevelopmentAccounts();
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(TEAM_ACCOUNTS.length);
  });

  it('removes the legacy accounts and their sessions, leaving the team alone', async () => {
    const alreadyLegacy = await User.countDocuments({ email: { $in: LEGACY_SEED_EMAILS } });

    // A stand-in for an address an earlier seed left behind. Drawn from
    // `LEGACY_SEED_EMAILS` so the removal actually targets it; the username is
    // distinct from the `legacy@claimdesk.test` account the password-cost case
    // above creates, because usernames are unique too.
    const stale = await User.create({
      email: 'locked@claimdesk.local',
      username: 'stale-account',
      passwordHash: await hashPassword('stale-password'),
      role: 'developer',
      active: true,
      profile: { fullName: 'Stale' },
    });
    await Session.create({
      tokenHash: hashSessionToken(randomBytes(32).toString('base64url')),
      user: stale._id,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await removeLegacyAccounts();
    expect(result.removed).toContain('locked@claimdesk.local');
    expect(result.removed).toHaveLength(alreadyLegacy + 1);
    expect(result.sessionsRemoved).toBeGreaterThanOrEqual(1);
    expect(await User.exists({ email: 'locked@claimdesk.local' })).toBeNull();
    expect(await Session.countDocuments({ user: stale._id })).toBe(0);
    expect(await User.countDocuments({ email: { $in: LEGACY_SEED_EMAILS } })).toBe(0);

    // Nobody the seed just created is touched.
    expect(await User.countDocuments({ email: { $in: TEAM_ACCOUNTS.map((a) => a.email) } })).toBe(
      TEAM_ACCOUNTS.length,
    );
  });

  it('refuses to seed development accounts in production', () => {
    expect(() => assertNotProduction('production')).toThrow(/production/);
    expect(() => assertNotProduction('development')).not.toThrow();
  });

  it('creates each client project once and scopes its client to it', async () => {
    const first = await seedProjects();
    expect(first.created).toHaveLength(TEAM_PROJECTS.length);

    const vybe = await Project.findOne({ slug: 'vybe-bank' }).exec();
    const gabriel = await User.findOne({ email: 'gabriel@vybebank.com' }).exec();
    // The tenant boundary reads `projectIds`, so an empty list is an empty board.
    expect(gabriel?.projectIds.map(String)).toEqual([vybe?._id.toHexString()]);
    expect(vybe?.members.map(String)).toContain(gabriel?._id.toHexString());

    const second = await seedProjects();
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(TEAM_PROJECTS.length);
    expect(second.linked).toHaveLength(0);
    expect(await Project.countDocuments({ slug: { $in: TEAM_PROJECTS.map((p) => p.slug) } })).toBe(
      TEAM_PROJECTS.length,
    );
  });
});

describe('the seed with no database', () => {
  beforeAll(async () => {
    await disconnect();
  });

  it('skips the administrator seed instead of crashing the boot', async () => {
    const result = await seedAdmin();

    expect(result.created).toBe(false);
    expect(result.reason).toBe('database_unavailable');
  });
});
