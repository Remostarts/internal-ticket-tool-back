import type { Express } from 'express';
import request from 'supertest';
import type { Role } from '@/shared';
import { User, type UserDocument } from '../../src/models/user.js';
import { hashPassword } from '../../src/services/password.js';
import { SESSION_COOKIE_NAME } from '../../src/services/session.js';

/**
 * Sign-in helpers for the auth suite.
 *
 * `signIn` returns the raw supertest response so a test can assert on the
 * failure shape as easily as on the success shape, and `cookieHeader` pulls the
 * one header a browser would replay. The cookie is read from the response, never
 * constructed by hand - a hand-built cookie would pass even if signing were
 * broken.
 */

export const TEST_PASSWORD = 'correct-horse-battery-staple';

export interface TestUserInput {
  email: string;
  username: string;
  password?: string;
  role?: Role;
  active?: boolean;
  mustChangePassword?: boolean;
  fullName?: string;
  /** Lets a test write a digest at an older cost and watch it get upgraded. */
  passwordCost?: number;
  /** Reuses a digest that already exists, so a fixture does not pay for bcrypt twice. */
  digest?: string;
}

export async function createTestUser(input: TestUserInput): Promise<UserDocument> {
  const digest =
    input.digest ??
    (input.passwordCost === undefined
      ? await hashPassword(input.password ?? TEST_PASSWORD)
      : // bcrypt's own module is used directly here: this is the one place a test
        // needs a hash the service would not produce.
        await (await import('bcrypt')).default.hash(input.password ?? TEST_PASSWORD, input.passwordCost));

  return User.create({
    email: input.email,
    username: input.username,
    passwordHash: digest,
    role: input.role ?? 'developer',
    active: input.active ?? true,
    mustChangePassword: input.mustChangePassword ?? false,
    profile: { fullName: input.fullName ?? 'Test Person' },
  });
}

export interface SignedIn {
  cookie: string;
  body: { user: Record<string, unknown> };
}

export async function signIn(
  app: Express,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<request.Response> {
  return request(app).post('/api/auth/login').send({ email, password });
}

/** The `Set-Cookie` pair a browser would send back, or null when none was issued. */
export function sessionCookieHeader(response: request.Response): string | null {
  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const pair = cookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
  return pair ? (pair.split(';')[0] ?? null) : null;
}

/** Signs in and fails loudly, so a helper mistake cannot look like a route failure. */
export async function signInAs(
  app: Express,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<SignedIn> {
  const response = await signIn(app, email, password);
  const cookie = sessionCookieHeader(response);
  if (response.status !== 200 || !cookie) {
    throw new Error(
      `signInAs(${email}) expected 200 with a session cookie, got ${response.status}: ${response.text}`,
    );
  }
  return { cookie, body: response.body as { user: Record<string, unknown> } };
}

/** The signature-stripped token inside a `cd_session=s:…` cookie pair. */
export function rawTokenFromCookie(cookie: string): string {
  // Express URL-encodes the `s:` prefix, so `s%3A` is what actually arrives.
  const value = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
  const unsigned = value.startsWith('s:') ? value.slice(2) : value;
  return unsigned.split('.')[0] ?? unsigned;
}
