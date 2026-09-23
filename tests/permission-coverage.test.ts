import { Router, type Express } from 'express';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, type Permission } from '@/shared';
import { createApp } from '../src/app.js';
import { requireAuth } from '../src/middleware/require-auth.js';
import { isPermissionGuard, requirePermission } from '../src/middleware/require-permission.js';
import { ROUTE_ACCESS_RULES, routeAccessRule } from '../src/routes/route-access.js';

/**
 * The permission-coverage proof (R004) - the milestone's definition of done.
 *
 * This suite does not trust a list of paths written by hand. It walks the real
 * Express router stack that `createApp()` builds, enumerates every mounted
 * route's handler chain, and asserts that each route outside the recorded
 * access allowlist carries both `requireAuth` and a `requirePermission` guard.
 * Remove a guard from a route and this fails; add a route with no guard and this
 * fails, because the expectation is derived from the application rather than
 * restated beside it.
 *
 * The walker is itself proved by the last test: a router with a bare route, a
 * route with only the authentication gate, and a route with both is injected
 * through the factory's `routers` option, and the first two must be reported as
 * offenders while the third is accepted. Without that test, a walker that
 * silently found nothing would make every assertion here vacuous.
 *
 * Exemptions live in `server/src/routes/route-access.ts` and each one carries a
 * written reason. `public` means a signed-out caller may use it; `authenticated`
 * means it still needs `requireAuth` but has no sensible permission key because
 * it can only reach the caller's own session or identity.
 */

interface HandlerLike {
  name?: string;
}

interface LayerLike {
  handle?: unknown;
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
    stack?: Array<{ handle?: unknown }>;
  };
}

export interface MountedRoute {
  method: string;
  path: string;
  /** Handler names in chain order, so a failure says which chain was found. */
  handlers: string[];
  hasRequireAuth: boolean;
  permissionGuards: Permission[];
}

function layersOf(container: unknown): LayerLike[] {
  const stack = (container as { stack?: unknown } | undefined)?.stack;
  return Array.isArray(stack) ? (stack as LayerLike[]) : [];
}

function inspect(handles: unknown[]): Pick<MountedRoute, 'handlers' | 'hasRequireAuth' | 'permissionGuards'> {
  const handlers: string[] = [];
  const permissionGuards: Permission[] = [];
  let hasRequireAuth = false;

  for (const handle of handles) {
    if (typeof handle !== 'function') {
      continue;
    }
    const name = (handle as HandlerLike).name || '(anonymous)';
    handlers.push(name);
    if (name === 'requireAuth') {
      hasRequireAuth = true;
    }
    if (isPermissionGuard(handle)) {
      permissionGuards.push(handle.permission);
    }
  }

  return { handlers, hasRequireAuth, permissionGuards };
}

/**
 * Every route mounted under the application, found by descending into routers.
 *
 * Routers are mounted with `app.use(router)` and declare absolute paths
 * (`/api/admin/audit`), so a nested router needs no path prefix here. That is
 * deliberate: the one-origin rewrite in `web/next.config.mjs` forwards `/api/*`
 * with the prefix intact, so every API route is absolute and there is exactly one
 * spelling of every path.
 */
export function collectRoutes(app: Express): MountedRoute[] {
  const found: MountedRoute[] = [];

  const visit = (container: unknown): void => {
    for (const layer of layersOf(container)) {
      const route = layer.route;
      if (route) {
        const path = route.path ?? '';
        const methods = Object.entries(route.methods ?? {})
          .filter(([, enabled]) => enabled)
          .map(([method]) => method.toUpperCase());
        const inspection = inspect((route.stack ?? []).map((entry) => entry.handle));
        for (const method of methods) {
          found.push({ method, path, ...inspection });
        }
        continue;
      }

      const handle = layer.handle;
      if (typeof handle === 'function' && layersOf(handle).length > 0) {
        visit(handle);
      }
    }
  };

  visit((app as unknown as { _router?: unknown })._router);
  return found;
}

/** Routes that must be fully guarded but are not: the failure this suite exists to catch. */
function unguardedRoutes(routes: MountedRoute[]): MountedRoute[] {
  return routes
    .filter((route) => routeAccessRule(route.method, route.path) === undefined)
    .filter((route) => !route.hasRequireAuth || route.permissionGuards.length === 0);
}

function formatRoute(route: MountedRoute): string {
  return `${route.method} ${route.path} (chain=[${route.handlers.join(', ')}])`;
}

const routes = collectRoutes(createApp());

describe('the route walker sees the real application', () => {
  it('enumerates the mounted routes, including both guarded admin routes', () => {
    const mounted = routes.map((route) => `${route.method} ${route.path}`);

    expect(mounted).toContain('GET /api/admin/audit');
    expect(mounted).toContain('GET /api/admin/overview');
    expect(mounted).toContain('POST /api/auth/login');
    expect(mounted).toContain('GET /health');
    expect(mounted.length).toBeGreaterThanOrEqual(7);
  });

  it('recognises the authentication gate by name, so the walker is not blind', () => {
    // If `requireAuth` stopped being identifiable the coverage assertions below
    // would pass for the wrong reason, so its discoverability is asserted first.
    expect(routes.filter((route) => route.hasRequireAuth).length).toBeGreaterThanOrEqual(4);
  });
});

describe('every mounted route is guarded or recorded as an exemption', () => {
  it('guards every route that is not in the access allowlist', () => {
    expect(unguardedRoutes(routes).map(formatRoute)).toEqual([]);
  });

  it('keeps every authenticated exemption behind the authentication gate', () => {
    const ownResource = routes.filter(
      (route) => routeAccessRule(route.method, route.path)?.access === 'authenticated',
    );

    expect(ownResource.length).toBeGreaterThan(0);
    expect(ownResource.filter((route) => !route.hasRequireAuth).map(formatRoute)).toEqual([]);
    expect(ownResource.filter((route) => route.permissionGuards.length > 0).map(formatRoute)).toEqual([]);
  });

  it('keeps the public surface down to signing in, Google sign-in, password recovery and the health probe', () => {
    // Deliberately hand-written: this is the contract the slice promises ("the
    // public surface is explicit and tiny"), not a copy of the table.
    const publicRoutes = routes
      .filter((route) => routeAccessRule(route.method, route.path)?.access === 'public')
      .map((route) => `${route.method} ${route.path}`)
      .sort();

    expect(publicRoutes).toEqual([
      'GET /api/auth/google/callback',
      'GET /api/auth/google/start',
      'GET /api/health',
      'GET /health',
      'POST /api/auth/login',
      'POST /api/auth/password/forgot',
      'POST /api/auth/password/reset',
    ]);
  });

  it('records only routes the application actually mounts', () => {
    const mounted = new Set(routes.map((route) => `${route.method} ${route.path}`));
    const stale = ROUTE_ACCESS_RULES.map((rule) => `${rule.method} ${rule.path}`).filter(
      (key) => !mounted.has(key),
    );

    expect(stale).toEqual([]);
  });

  it('uses only permission keys the shared vocabulary defines', () => {
    const used = routes.flatMap((route) => route.permissionGuards);

    expect(used.length).toBeGreaterThanOrEqual(2);
    expect(used.filter((key) => !ALL_PERMISSIONS.includes(key))).toEqual([]);
  });
});

describe('the coverage rule itself', () => {
  it('reports a route whose guard was removed, and accepts the one that kept it', () => {
    const bare = Router();
    bare.get('/api/unguarded', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    bare.get('/api/unguarded-self', requireAuth, (_req, res) => {
      res.status(200).json({ ok: true });
    });
    bare.get('/api/guarded', requireAuth, requirePermission('audit:read'), (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const injected = collectRoutes(createApp({ routers: [bare] }));

    expect(unguardedRoutes(injected).map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /api/unguarded',
      'GET /api/unguarded-self',
    ]);

    const guarded = injected.find((route) => route.path === '/api/guarded');
    expect(guarded?.hasRequireAuth).toBe(true);
    expect(guarded?.permissionGuards).toEqual(['audit:read']);
  });
});
