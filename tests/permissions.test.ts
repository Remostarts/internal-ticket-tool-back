import { Router, type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROLES, roleHasPermission, type Permission, type Role } from '@/shared';
import { createApp } from '../src/app.js';
import { logger } from '../src/logging/logger.js';
import { AUDIT_ACTIONS, AuditLog } from '../src/models/audit-log.js';
import { User } from '../src/models/user.js';
import { requirePermission } from '../src/middleware/require-permission.js';
import { hashPassword } from '../src/services/password.js';
import { createTestUser, signInAs, TEST_PASSWORD } from './helpers/auth.js';
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from './helpers/test-db.js';

/**
 * The role gate (R004, R018, D004) - the slice's proof obligation.
 *
 * The plan is explicit that this is retired by an *allowed* and a *blocked* call
 * for two different roles, through the real Express stack with real signed
 * cookies, not by reading the middleware. So every call here runs through
 * `createApp()`: helmet, cookie parsing, the request log, `requireAuth`, the
 * permission guard, the handler, the failure handler.
 *
 * What each group proves:
 *
 *   - a developer is refused `GET /api/admin/audit` with 403 `PERMISSION_DENIED`
 *     naming `audit:read`, while a manager is allowed the same route - the
 *     allowed/blocked pair the proof strategy asks for;
 *   - a manager is refused `GET /api/admin/overview` (`admin:access`), so the
 *     stricter key is a real second gate and not the same check twice;
 *   - the expectation for every role is derived from `@/shared`
 *     (`roleHasPermission`) rather than a hand-written role list, so adding a
 *     role cannot silently leave a gap;
 *   - the verdict follows the *user document*, not the request: a forged
 *     `X-Role` header, a `?role=` query or a `?permission=` query changes
 *     nothing, and promoting a developer in the database takes effect on their
 *     very next request;
 *   - a signed-out caller gets 401 `UNAUTHENTICATED`, never 403, so a person who
 *     is not signed in is never told which permission the route would have
 *     needed;
 *   - a refusal is written to the audit trail and logged at warn level, and
 *     neither a failing audit write nor a failing identity lookup can turn a 403
 *     into an allow.
 */

const app: Express = createApp();

const cookies = new Map<Role, string>();
const userIds = new Map<Role, string>();
let sharedDigest = '';

function cookieFor(role: Role): string {
  const cookie = cookies.get(role);
  if (!cookie) {
    throw new Error(`no signed-in ${role} cookie was captured in beforeAll`);
  }
  return cookie;
}

function idFor(role: Role): string {
  const id = userIds.get(role);
  if (!id) {
    throw new Error(`no ${role} user was created in beforeAll`);
  }
  return id;
}

async function cookieForNewUser(email: string, username: string, role: Role): Promise<string> {
  await createTestUser({ email, username, role, digest: sharedDigest });
  const signedIn = await signInAs(app, email);
  return signedIn.cookie;
}

beforeAll(async () => {
  await startTestDatabase();
  await resetTestDatabase();

  // One digest for every account: bcrypt at cost 12 six times over would make
  // this suite slow without proving anything about hashing.
  sharedDigest = await hashPassword(TEST_PASSWORD);

  for (const role of ROLES) {
    const user = await createTestUser({
      email: `${role}@claimdesk.test`,
      username: role,
      role,
      digest: sharedDigest,
      fullName: `${role} account`,
    });
    userIds.set(role, String(user._id));
  }

  for (const role of ROLES) {
    const signedIn = await signInAs(app, `${role}@claimdesk.test`);
    cookies.set(role, signedIn.cookie);
  }
});

afterAll(async () => {
  await stopTestDatabase();
});

describe('GET /api/admin/audit behind audit:read', () => {
  it('refuses a developer, naming the missing permission key', async () => {
    const response = await request(app).get('/api/admin/audit').set('Cookie', cookieFor('developer'));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('PERMISSION_DENIED');
    expect(response.body.details).toEqual({ requiredPermission: 'audit:read', role: 'developer' });
  });

  it('allows a manager on the very same route', async () => {
    const response = await request(app).get('/api/admin/audit').set('Cookie', cookieFor('manager'));

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.entries)).toBe(true);
    expect(response.body.page).toBe(1);
    expect(response.body.pageSize).toBe(25);
  });

  it('refuses a manager the stricter route behind admin:access', async () => {
    const response = await request(app).get('/api/admin/overview').set('Cookie', cookieFor('manager'));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('PERMISSION_DENIED');
    expect(response.body.details).toEqual({ requiredPermission: 'admin:access', role: 'manager' });
  });

  it('allows the administrator both routes', async () => {
    const audit = await request(app).get('/api/admin/audit').set('Cookie', cookieFor('admin'));
    const overview = await request(app).get('/api/admin/overview').set('Cookie', cookieFor('admin'));

    expect(audit.status).toBe(200);
    expect(overview.status).toBe(200);
  });

  it('follows the ladder from @/shared for every role, not a hand-written list', async () => {
    const cases: Array<{ path: string; permission: Permission }> = [
      { path: '/api/admin/audit', permission: 'audit:read' },
      { path: '/api/admin/overview', permission: 'admin:access' },
    ];

    for (const testCase of cases) {
      for (const role of ROLES) {
        const response = await request(app).get(testCase.path).set('Cookie', cookieFor(role));
        const expectedStatus = roleHasPermission(role, testCase.permission) ? 200 : 403;

        // The whole object is compared so a failure names the role and the route.
        expect({ role, path: testCase.path, status: response.status }).toEqual({
          role,
          path: testCase.path,
          status: expectedStatus,
        });
      }
    }
  });
});

describe('the permission gate decides from the user document', () => {
  it('ignores a role, permission or user id supplied by the request', async () => {
    const response = await request(app)
      .get('/api/admin/overview?role=cto&permission=admin:access&permissions=admin:access')
      .set('Cookie', cookieFor('developer'))
      .set('X-Role', 'cto')
      .set('X-Permission', 'admin:access')
      .set('X-Permissions', 'admin:access')
      .set('X-User-Id', idFor('cto'));

    expect(response.status).toBe(403);
    expect(response.body.details).toEqual({ requiredPermission: 'admin:access', role: 'developer' });
  });

  it('follows a role change on the next request', async () => {
    const email = 'promotee@claimdesk.test';
    const cookie = await cookieForNewUser(email, 'promotee', 'developer');

    const before = await request(app).get('/api/admin/overview').set('Cookie', cookie);
    expect(before.status).toBe(403);

    await User.updateOne({ email }, { $set: { role: 'cto' } });

    const after = await request(app).get('/api/admin/overview').set('Cookie', cookie);
    expect(after.status).toBe(200);
  });
});

describe('a signed-out caller is never told which permission exists', () => {
  it('answers an unauthenticated admin call with 401 UNAUTHENTICATED', async () => {
    const response = await request(app).get('/api/admin/audit');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    expect(response.body.details).toBeUndefined();
  });
});

describe('the refusal is recorded', () => {
  it('writes a permission.denied record naming the path and the missing key', async () => {
    const managerId = idFor('manager');
    const filter = { action: AUDIT_ACTIONS.PERMISSION_DENIED, resourceId: 'GET /api/admin/overview' };
    const before = await AuditLog.countDocuments(filter);

    const refused = await request(app).get('/api/admin/overview').set('Cookie', cookieFor('manager'));
    expect(refused.status).toBe(403);

    const records = await AuditLog.find(filter).sort({ timestamp: -1 }).lean();
    expect(records).toHaveLength(before + 1);
    expect(records[0]?.user?.toHexString()).toBe(managerId);
    expect(records[0]?.resourceType).toBe('route');
    expect(records[0]?.details).toMatchObject({
      permission: 'admin:access',
      role: 'manager',
      method: 'GET',
      path: '/api/admin/overview',
    });

    // And the trail the manager is allowed to read names the actor and the key.
    const trail = await request(app)
      .get(`/api/admin/audit?action=${AUDIT_ACTIONS.PERMISSION_DENIED}&actor=${managerId}&pageSize=1`)
      .set('Cookie', cookieFor('manager'));

    expect(trail.status).toBe(200);
    expect(trail.body.entries[0]?.actor).toEqual({
      id: managerId,
      username: 'manager',
      email: 'manager@claimdesk.test',
    });
    expect(trail.body.entries[0]?.details).toMatchObject({ permission: 'admin:access' });
  });

  it('logs the refusal at warn level with the key and the effective role', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');

    const response = await request(app).get('/api/admin/audit').set('Cookie', cookieFor('developer'));
    expect(response.status).toBe(403);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'developer', permission: 'audit:read', method: 'GET' }),
      'permission denied',
    );
  });
});

describe('the audit trail read', () => {
  it('returns the newest records first and paginates them', async () => {
    const base = Date.now() - 60_000;
    await AuditLog.create([
      { action: 'test.pagination', timestamp: new Date(base - 2000), details: { n: 1 } },
      { action: 'test.pagination', timestamp: new Date(base - 1000), details: { n: 2 } },
      { action: 'test.pagination', timestamp: new Date(base), details: { n: 3 } },
    ]);

    const firstPage = await request(app)
      .get('/api/admin/audit?action=test.pagination&pageSize=2')
      .set('Cookie', cookieFor('manager'));

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.total).toBe(3);
    expect(firstPage.body.totalPages).toBe(2);
    expect(firstPage.body.hasMore).toBe(true);
    expect(firstPage.body.entries).toHaveLength(2);
    expect(firstPage.body.entries.map((entry: { details: { n: number } }) => entry.details.n)).toEqual([3, 2]);

    const secondPage = await request(app)
      .get('/api/admin/audit?action=test.pagination&pageSize=2&page=2')
      .set('Cookie', cookieFor('manager'));

    expect(secondPage.body.entries).toHaveLength(1);
    expect(secondPage.body.entries[0]?.details.n).toBe(1);
    expect(secondPage.body.hasMore).toBe(false);
  });

  it('refuses a page it cannot parse instead of guessing', async () => {
    const queries = ['page=0', 'page=abc', 'pageSize=100000', 'actor=not-an-object-id'];

    for (const query of queries) {
      const response = await request(app).get(`/api/admin/audit?${query}`).set('Cookie', cookieFor('admin'));

      expect({ query, status: response.status }).toEqual({ query, status: 400 });
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(Array.isArray(response.body.details.fields)).toBe(true);
    }
  });
});

describe('GET /api/admin/overview reports the control-room counts', () => {
  it('answers users by role, active users and live sessions', async () => {
    const response = await request(app).get('/api/admin/overview').set('Cookie', cookieFor('admin'));

    expect(response.status).toBe(200);
    expect(response.body.users.total).toBeGreaterThanOrEqual(ROLES.length);
    expect(response.body.users.active + response.body.users.inactive).toBe(response.body.users.total);
    expect(Object.keys(response.body.users.byRole).sort()).toEqual([...ROLES].sort());
    expect(response.body.sessions.live).toBeGreaterThanOrEqual(ROLES.length);
    expect(typeof response.body.generatedAt).toBe('string');
  });
});

describe('the gate when a dependency fails', () => {
  it('answers 500 INTERNAL, never a permission verdict, when the identity lookup fails', async () => {
    const failingFindById = (() =>
      Promise.reject(new Error('mongodb unreachable'))) as unknown as typeof User.findById;
    const spy = vi.spyOn(User, 'findById').mockImplementation(failingFindById);

    const response = await request(app).get('/api/admin/audit').set('Cookie', cookieFor('admin'));

    expect(spy).toHaveBeenCalled();
    expect(response.status).toBe(500);
    expect(response.body.code).toBe('INTERNAL');
    // The reason is logged, never returned.
    expect(response.text).not.toContain('mongodb unreachable');
  });

  it('answers 500 INTERNAL when the audit read fails', async () => {
    const failingQuery = {
      sort: () => failingQuery,
      skip: () => failingQuery,
      limit: () => failingQuery,
      populate: () => failingQuery,
      lean: () => failingQuery,
      exec: () => Promise.reject(new Error('audit store unavailable')),
    };
    vi.spyOn(AuditLog, 'find').mockImplementation((() => failingQuery) as unknown as typeof AuditLog.find);

    const response = await request(app).get('/api/admin/audit').set('Cookie', cookieFor('admin'));

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('INTERNAL');
  });

  it('still refuses with 403 when the audit write fails, so a broken store cannot change a verdict', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    const failingCreate = (() =>
      Promise.reject(new Error('audit store unavailable'))) as unknown as typeof AuditLog.create;
    vi.spyOn(AuditLog, 'create').mockImplementation(failingCreate);

    const response = await request(app).get('/api/admin/overview').set('Cookie', cookieFor('developer'));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('PERMISSION_DENIED');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.PERMISSION_DENIED }),
      'audit record not written',
    );
  });
});

describe('a guard mounted without the authentication gate', () => {
  it('refuses with 401 and says the chain is wrong, rather than allowing the request', async () => {
    const misconfigured = Router();
    misconfigured.get('/api/misconfigured', requirePermission('audit:read'), (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const errorSpy = vi.spyOn(logger, 'error');
    const response = await request(createApp({ routers: [misconfigured] })).get('/api/misconfigured');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ permission: 'audit:read' }),
      expect.stringContaining('without an authenticated identity'),
    );
  });
});
