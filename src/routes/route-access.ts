import { HEALTH_PATHS } from './health.js';

/**
 * The route access table (R004).
 *
 * One exported constant, and the only place a route is allowed to be less than
 * fully guarded. Everything mounted in `createApp()` that is *not* recorded here
 * must carry `requireAuth` and a `requirePermission` key, and
 * `tests/permission-coverage.test.ts` walks the application's real router stack
 * to prove it - so a route added tomorrow without a guard fails the suite, and a
 * route recorded here that is no longer mounted fails it too.
 *
 * Two exemptions exist, and the distinction matters:
 *
 *   - `public` - the route answers a signed-out caller. Sign-in, Google
 *     sign-in, the two password-recovery routes and the health probe are like
 *     this: nobody can sign in if signing in needs a session, a forgotten
 *     password is the one moment a person has no session at all, and the probe
 *     that reports the API is degraded cannot itself require the database to be
 *     up.
 *   - `authenticated` - the route needs a caller but no permission key, because
 *     the only thing it can reach is the caller's own session or identity.
 *     `requireAuth` is still asserted for these by the coverage test; there is
 *     simply no sensible key to demand, and inventing one (`profile:read` on
 *     "who am I") would make the shell break for any future role that lacks it.
 *
 * The permission keys themselves are not restated here. A guarded route declares
 * its key where it is mounted (`requirePermission('audit:read')`), and the
 * contract tests in `tests/permissions.test.ts` prove the key is enforced.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type RouteAccess = 'public' | 'authenticated';

export interface RouteAccessRule {
  method: HttpMethod;
  path: string;
  access: RouteAccess;
  /** Why this route may skip the permission key. Read by a human, not by code. */
  reason: string;
}

export const ROUTE_ACCESS_RULES: readonly RouteAccessRule[] = [
  {
    method: 'POST',
    path: '/api/auth/login',
    access: 'public',
    reason: 'Sign-in cannot require a session; it is where a session comes from.',
  },
  {
    method: 'GET',
    path: '/api/auth/google/start',
    access: 'public',
    reason: 'Google sign-in cannot require a session; it is where a session comes from.',
  },
  {
    method: 'GET',
    path: '/api/auth/google/callback',
    access: 'public',
    reason:
      'Google returns the browser here before any session exists; its authority is the signed state cookie, not a session.',
  },
  ...HEALTH_PATHS.map(
    (path): RouteAccessRule => ({
      method: 'GET',
      path,
      access: 'public',
      reason: 'The probe must answer when the database is down, so it cannot sit behind a session lookup.',
    }),
  ),
  {
    method: 'POST',
    path: '/api/auth/password/forgot',
    access: 'public',
    reason:
      'A forgotten password is the one moment a person has no session; asking for a reset link cannot require one.',
  },
  {
    method: 'POST',
    path: '/api/auth/password/reset',
    access: 'public',
    reason:
      'The emailed link is the whole credential here; the caller has no session until the new password is set.',
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    access: 'authenticated',
    reason: 'Ending your own session needs a session, not a permission key.',
  },
  {
    method: 'GET',
    path: '/api/auth/me',
    access: 'authenticated',
    reason: 'Returns the caller their own identity and resolved permissions; nothing else is reachable.',
  },
];

/** The recorded rule for a mounted route, or undefined when it should be fully guarded. */
export function routeAccessRule(method: string, path: string): RouteAccessRule | undefined {
  const upper = method.toUpperCase();
  return ROUTE_ACCESS_RULES.find((rule) => rule.method === upper && rule.path === path);
}

export function isPublicRoute(method: string, path: string): boolean {
  return routeAccessRule(method, path)?.access === 'public';
}
