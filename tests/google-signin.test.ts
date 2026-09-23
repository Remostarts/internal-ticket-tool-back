import { createHash } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { AUDIT_ACTIONS, AuditLog } from '../src/models/audit-log.js';
import { User } from '../src/models/user.js';
import {
  createGoogleVerifier,
  googleCallbackCookieNames,
  type GoogleAuthorizationInput,
  type GoogleExchangeInput,
  type GoogleIdentity,
  type GoogleVerifier,
} from '../src/services/google.js';
import { hashPassword } from '../src/services/password.js';
import { createTestUser, sessionCookieHeader, signInAs, TEST_PASSWORD } from './helpers/auth.js';
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from './helpers/test-db.js';

/**
 * Google sign-in end to end (R013).
 *
 * The real verifier is replaced by a stub, which is the point: the whole
 * callback contract is provable without Google credentials and without a single
 * network call. What the stub records is as important as what it returns - the
 * `state` it was asked to authorize, the PKCE challenge, and the `code_verifier`
 * the callback later hands back - so the test can prove the S256 round trip
 * rather than assert that two strings merely exist.
 *
 * The properties that matter, in the order they are defended:
 *
 *   - an installation with no client configured bounces back to the login screen
 *     with a written reason and sets no state cookie;
 *   - state is compared byte-for-byte against the signed cookie, and the one-shot
 *     cookie pair is cleared on arrival;
 *   - an unverified address is not an identity, an unknown address is refused
 *     without ever creating an account, and a deactivated account is refused;
 *   - a successful callback lands in the *same* account and the *same* session
 *     shape as the password path, and records the Google subject once;
 *   - the lockout (T04) does not bar the Google path.
 *
 * `createGoogleVerifier` itself is proved without credentials: the `configured`
 * flag and the generated authorization URL are pure functions of the id, secret
 * and redirect URI.
 */

/** Records what it was asked and returns whatever the test told it to. */
class StubGoogleVerifier implements GoogleVerifier {
  readonly authorizations: GoogleAuthorizationInput[] = [];
  readonly exchanges: GoogleExchangeInput[] = [];
  identity: GoogleIdentity = {
    subject: 'google-subject-1',
    email: 'ada@claimdesk.test',
    emailVerified: true,
    fullName: 'Ada Lovelace',
    pictureUrl: 'https://example.test/ada.png',
  };
  failure: Error | null = null;

  constructor(readonly configured: boolean = true) {}

  authorizationUrl(input: GoogleAuthorizationInput): string {
    this.authorizations.push(input);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', 'stub-client-id');
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async exchange(input: GoogleExchangeInput): Promise<GoogleIdentity> {
    this.exchanges.push(input);
    if (this.failure) {
      throw this.failure;
    }
    return this.identity;
  }

  /** The most recent authorization request, or a loud failure. */
  lastAuthorization(): GoogleAuthorizationInput {
    const last = this.authorizations[this.authorizations.length - 1];
    if (!last) {
      throw new Error('the stub verifier was never asked for an authorization URL');
    }
    return last;
  }
}

let app: Express;
let unconfiguredApp: Express;
let stub: StubGoogleVerifier;
let passwordDigest: string;

/** The `name=value` pairs from a response, ready to replay as a Cookie header. */
function cookiePairs(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.map((cookie) => cookie.split(';')[0] ?? '');
}

/** Runs `/start` against the configured app and returns everything a callback needs. */
async function startGoogle(target: Express = app): Promise<{
  response: request.Response;
  cookieHeader: string;
  state: string;
  codeChallenge: string;
}> {
  const response = await request(target).get('/api/auth/google/start').redirects(0);
  const authorization = stub.lastAuthorization();
  return {
    response,
    cookieHeader: cookiePairs(response).join('; '),
    state: authorization.state,
    codeChallenge: authorization.codeChallenge,
  };
}

function callback(query: Record<string, string>, cookieHeader?: string): request.Test {
  const test = request(app).get('/api/auth/google/callback').query(query).redirects(0);
  return cookieHeader === undefined ? test : test.set('Cookie', cookieHeader);
}

/** Asserts a refusal redirect and returns the error code it carried. */
function refusalCode(response: request.Response): string | null {
  const location = response.headers.location;
  if (!location) {
    throw new Error(`expected a redirect, got ${response.status}: ${response.text}`);
  }
  const url = new URL(location);
  expect(url.origin).toBe(env.WEB_ORIGIN);
  expect(url.pathname).toBe('/login');
  return url.searchParams.get('error');
}

function createAda(overrides: Partial<{ googleId: string; active: boolean; locked: boolean }> = {}) {
  return createTestUser({
    email: 'ada@claimdesk.test',
    username: 'ada',
    digest: passwordDigest,
    fullName: 'Ada Lovelace',
  }).then(async (user) => {
    if (overrides.googleId !== undefined) {
      user.googleId = overrides.googleId;
    }
    if (overrides.active !== undefined) {
      user.active = overrides.active;
    }
    if (overrides.locked) {
      user.failedLoginAttempts = 6;
      user.lockedUntil = new Date(Date.now() + 15 * 60_000);
    }
    await user.save();
    return user;
  });
}

beforeAll(async () => {
  await startTestDatabase();
  // One bcrypt digest, reused by every fixture: the suite is about Google, not
  // about hashing, and a per-test hash would dominate the runtime.
  passwordDigest = await hashPassword(TEST_PASSWORD);
});

beforeEach(async () => {
  await resetTestDatabase();
  stub = new StubGoogleVerifier();
  app = createApp({ auth: { google: { verifier: stub }, loginRateLimit: false, forgotRateLimit: false } });
  unconfiguredApp = createApp({
    auth: { google: { verifier: new StubGoogleVerifier(false) }, loginRateLimit: false, forgotRateLimit: false },
  });
});

afterAll(async () => {
  await stopTestDatabase();
});

describe('GET /api/auth/google/start', () => {
  it('bounces an unconfigured installation back to the login screen and sets no state cookie', async () => {
    const response = await request(unconfiguredApp).get('/api/auth/google/start').redirects(0);

    expect(response.status).toBe(302);
    expect(refusalCode(response)).toBe('google_not_configured');
    const names = googleCallbackCookieNames();
    expect(cookiePairs(response).some((pair) => pair.startsWith(`${names.state}=`))).toBe(false);
    expect(cookiePairs(response).some((pair) => pair.startsWith(`${names.verifier}=`))).toBe(false);
  });

  it('sends the browser to Google with state and a PKCE S256 challenge, in signed httpOnly cookies', async () => {
    const { response, state, codeChallenge } = await startGoogle();

    expect(response.status).toBe(302);
    const location = new URL(response.headers.location ?? '');
    expect(location.host).toBe('accounts.google.com');
    expect(location.searchParams.get('state')).toBe(state);
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(location.searchParams.get('code_challenge')).toBe(codeChallenge);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');

    const names = googleCallbackCookieNames();
    const raw = response.headers['set-cookie'] as unknown as string[];
    for (const name of [names.state, names.verifier]) {
      const cookie = raw.find((entry) => entry.startsWith(`${name}=s%3A`));
      expect(cookie, `${name} should be a signed cookie`).toBeDefined();
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('Max-Age=600');
    }
  });
});

describe('GET /api/auth/google/callback', () => {
  it('lands in the same account and the same session the password path issues', async () => {
    const user = await createAda();
    const { cookieHeader, state, codeChallenge } = await startGoogle();

    const response = await callback({ code: 'stub-code', state }, cookieHeader);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(new URL('/', env.WEB_ORIGIN).toString());

    const cookie = sessionCookieHeader(response);
    expect(cookie).not.toBeNull();

    // The callback redeemed the code with the verifier the cookie carried, and
    // that verifier's S256 digest is the challenge Google was given.
    const exchange = stub.exchanges[0];
    expect(exchange?.code).toBe('stub-code');
    expect(exchange?.redirectUri.length).toBeGreaterThan(0);
    expect(createHash('sha256').update(exchange?.codeVerifier ?? '').digest('base64url')).toBe(
      codeChallenge,
    );

    // The session that follows is indistinguishable from the password path's.
    // `lastLoginAt` is the one field that differs - each path writes its own
    // instant - so everything else is compared, and that field is proved set.
    const viaGoogle = await request(app).get('/api/auth/me').set('Cookie', cookie as string);
    const viaPassword = await signInAs(app, user.email);
    expect(viaGoogle.status).toBe(200);
    const googleUser = viaGoogle.body.user as Record<string, unknown>;
    const passwordUser = viaPassword.body.user as Record<string, unknown>;
    expect(googleUser.id).toBe(passwordUser.id);
    expect(googleUser.email).toBe(passwordUser.email);
    expect(googleUser.username).toBe(passwordUser.username);
    expect(googleUser.role).toBe(passwordUser.role);
    expect(googleUser.permissions).toEqual(passwordUser.permissions);
    expect(googleUser.mustChangePassword).toBe(passwordUser.mustChangePassword);
    expect(googleUser.profile).toEqual(passwordUser.profile);
    expect(new Date(googleUser.lastLoginAt as string).getTime()).toBeGreaterThan(0);

    const stored = await User.findById(user._id);
    expect(stored?.googleId).toBe('google-subject-1');
    expect(stored?.lastLoginAt).not.toBeNull();

    // Scoped by method: the password sign-in above wrote an `auth.login` of its
    // own, and the audit indexes order by timestamp descending.
    expect(
      await AuditLog.countDocuments({ action: AUDIT_ACTIONS.LOGIN, 'details.method': 'google' }),
    ).toBe(1);
  });

  it('answers JSON when the caller explicitly asks for it instead of redirecting', async () => {
    await createAda();
    const { cookieHeader, state } = await startGoogle();

    const response = await request(app)
      .get('/api/auth/google/callback')
      .query({ code: 'stub-code', state })
      .set('Cookie', cookieHeader)
      .set('Accept', 'application/json');

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe('ada@claimdesk.test');
    expect(sessionCookieHeader(response)).not.toBeNull();
  });

  it('clears the one-shot cookie pair on arrival', async () => {
    await createAda();
    const { cookieHeader, state } = await startGoogle();

    const response = await callback({ code: 'stub-code', state }, cookieHeader);
    const names = googleCallbackCookieNames();
    const cleared = cookiePairs(response);

    expect(cleared).toContain(`${names.state}=`);
    expect(cleared).toContain(`${names.verifier}=`);
  });

  it('keeps a Google subject that is already recorded', async () => {
    const user = await createAda({ googleId: 'first-subject' });
    const { cookieHeader, state } = await startGoogle();

    const response = await callback({ code: 'stub-code', state }, cookieHeader);

    expect(response.status).toBe(302);
    expect((await User.findById(user._id))?.googleId).toBe('first-subject');
  });

  it('refuses a state that does not match the signed cookie', async () => {
    await createAda();
    const { cookieHeader } = await startGoogle();

    const response = await callback({ code: 'stub-code', state: 'not-the-state' }, cookieHeader);

    expect(response.status).toBe(302);
    expect(refusalCode(response)).toBe('google_failed');
    expect(sessionCookieHeader(response)).toBeNull();
  });

  it('refuses a callback with no cookies at all', async () => {
    await createAda();
    const { state } = await startGoogle();

    const response = await callback({ code: 'stub-code', state });

    expect(refusalCode(response)).toBe('google_failed');
    expect(sessionCookieHeader(response)).toBeNull();
  });

  it('refuses a callback with no authorization code', async () => {
    await createAda();
    const { cookieHeader, state } = await startGoogle();

    expect(refusalCode(await callback({ state }, cookieHeader))).toBe('google_failed');
  });

  it('names a cancellation by the person, and any other provider error generically', async () => {
    await createAda();

    expect(refusalCode(await callback({ error: 'access_denied' }))).toBe('google_cancelled');
    expect(refusalCode(await callback({ error: 'server_error' }))).toBe('google_failed');
  });

  it('refuses an address Google has not verified', async () => {
    await createAda();
    stub.identity = { ...stub.identity, emailVerified: false };
    const { cookieHeader, state } = await startGoogle();

    const response = await callback({ code: 'stub-code', state }, cookieHeader);

    expect(refusalCode(response)).toBe('google_failed');
    expect(sessionCookieHeader(response)).toBeNull();
  });

  it('refuses an address with no account and never creates one', async () => {
    stub.identity = { ...stub.identity, email: 'stranger@claimdesk.test' };
    const { cookieHeader, state } = await startGoogle();

    const response = await callback({ code: 'stub-code', state }, cookieHeader);

    expect(refusalCode(response)).toBe('google_no_account');
    expect(sessionCookieHeader(response)).toBeNull();
    expect(await User.countDocuments({ email: 'stranger@claimdesk.test' })).toBe(0);
  });

  it('refuses a deactivated account', async () => {
    await createAda({ active: false });
    const { cookieHeader, state } = await startGoogle();

    const response = await callback({ code: 'stub-code', state }, cookieHeader);

    expect(refusalCode(response)).toBe('google_inactive');
    expect(sessionCookieHeader(response)).toBeNull();
  });

  it('turns a verifier failure into the generic refusal without echoing it', async () => {
    await createAda();
    stub.failure = new Error('token exchange exploded: secret-material');
    const { cookieHeader, state } = await startGoogle();

    const response = await callback({ code: 'stub-code', state }, cookieHeader);

    expect(refusalCode(response)).toBe('google_failed');
    expect(response.text).not.toContain('secret-material');
  });

  it('signs in an account that is locked on the password path', async () => {
    const user = await createAda({ locked: true });
    const { cookieHeader, state } = await startGoogle();

    const response = await callback({ code: 'stub-code', state }, cookieHeader);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(new URL('/', env.WEB_ORIGIN).toString());
    const cookie = sessionCookieHeader(response);
    expect(cookie).not.toBeNull();
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie as string)).status).toBe(200);
    // The lock is password-path state and is left alone by the Google path.
    expect((await User.findById(user._id))?.lockedUntil).not.toBeNull();
  });
});

describe('createGoogleVerifier', () => {
  it('reports itself unconfigured, and refuses, when either credential is blank', () => {
    const verifier = createGoogleVerifier({ clientId: 'client-id', clientSecret: '' });

    expect(verifier.configured).toBe(false);
    expect(() => verifier.authorizationUrl({ state: 's', codeChallenge: 'c', redirectUri: 'r' })).toThrow(
      /GOOGLE_CLIENT_ID/,
    );
  });

  it('builds a real Google authorization URL from injected credentials, with no network call', () => {
    const redirectUri = `${env.WEB_ORIGIN}/api/auth/google/callback`;
    const verifier = createGoogleVerifier({
      clientId: 'injected-client-id',
      clientSecret: 'injected-client-secret',
      redirectUri,
    });

    expect(verifier.configured).toBe(true);
    const url = new URL(
      verifier.authorizationUrl({ state: 'the-state', codeChallenge: 'the-challenge', redirectUri }),
    );

    expect(url.host).toBe('accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe('injected-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.get('state')).toBe('the-state');
    expect(url.searchParams.get('code_challenge')).toBe('the-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('scope')).toContain('email');
  });

  describe.skipIf(!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)(
    'with real credentials in the environment',
    () => {
      it('reports configured and points at Google with the configured client id', () => {
        const verifier = createGoogleVerifier();

        expect(verifier.configured).toBe(true);
        const url = new URL(
          verifier.authorizationUrl({ state: 'live-state', codeChallenge: 'live-challenge', redirectUri: 'http://localhost:3000/x' }),
        );
        expect(url.host).toBe('accounts.google.com');
        expect(url.searchParams.get('client_id')).toBe(process.env.GOOGLE_CLIENT_ID);
      });
    },
  );
});
