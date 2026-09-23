import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Permission, Role } from '@/shared';
import { resolveUserPermissions } from '../services/roles.js';
import { logger } from '../logging/logger.js';
import { AUDIT_ACTIONS } from '../models/audit-log.js';
import { writeAudit } from '../services/audit.js';
import { AppError } from './error-handler.js';
import { requestPath } from './request-logger.js';
import type { AuthenticatedRequest } from './require-auth.js';

/**
 * The permission gate (R004, R018, D004).
 *
 * Mounted immediately after `requireAuth`, which is where the caller's identity
 * comes from. This is the whole of the authorization model and it lives on the
 * server, in front of the handler, so the interface cannot be the thing that
 * decides who may do what:
 *
 *   - the effective permission list is resolved from the *user document* the
 *     request gate just loaded, through the shared ladder in `@/shared`
 *     - never from a request header, a query string, a body field or a cookie
 *     value. A caller who sends `X-Role: cto` is still whatever their document
 *     says they are.
 *   - the same `Permission` keys the web shell filters its navigation on are the
 *     keys enforced here, so a menu entry and the route behind it cannot
 *     disagree about who may open it.
 *   - a refusal is 403 `PERMISSION_DENIED` carrying `{requiredPermission, role}`
 *     so the web permission-denied panel can name the missing key, and it is
 *     written to the audit trail (`permission.denied`) as well as logged at warn
 *     level - a refusal is a normal outcome, but a spike in 403s is a permission
 *     model problem, not noise.
 *
 * A caller who is not signed in gets 401 `UNAUTHENTICATED` from `requireAuth`
 * before this runs, so a signed-out person is never told which permission their
 * route would have needed.
 */

/**
 * The marker the route-coverage test reads to prove a route carries a real
 * permission guard. It is a value on the handler rather than the handler's
 * `name`, because the key is data, not an identifier: two guards on two routes
 * share the name.
 */
export const PERMISSION_GUARD_KIND = 'requirePermission' as const;

/** A handler chain entry that can be recognised as a permission guard. */
export interface PermissionGuard extends RequestHandler {
  readonly guardKind: typeof PERMISSION_GUARD_KIND;
  readonly permission: Permission;
}

export function isPermissionGuard(value: unknown): value is PermissionGuard {
  return (
    typeof value === 'function' &&
    (value as { guardKind?: unknown }).guardKind === PERMISSION_GUARD_KIND
  );
}

/**
 * Builds the guard for one named permission key.
 *
 * The returned handler is deliberately self-describing (`guardKind` +
 * `permission`) so the coverage test in `tests/permission-coverage.test.ts` can
 * walk the mounted route table and fail when a guard is missing - the guard's
 * presence is asserted from the application's real router stack rather than from
 * a hand-copied list of paths.
 */
export function requirePermission(permission: Permission): PermissionGuard {
  const guard = ((req: Request, _res: Response, next: NextFunction): void => {
    void (async (): Promise<void> => {
      const identity = (req as Partial<AuthenticatedRequest>).identity;

      if (!identity) {
        // The guard was mounted without `requireAuth` ahead of it. Refuse and
        // say so loudly: an unauthenticated request must never slip past a
        // permission gate, and a wiring mistake must not look like a quiet
        // allow.
        logger.error(
          { method: req.method, path: requestPath(req), permission },
          'permission guard reached without an authenticated identity; check the route chain',
        );
        throw new AppError('UNAUTHENTICATED');
      }

      const user = identity.user;
      const role = user.role;
      const effective = await resolveUserPermissions(user);

      if (!effective.includes(permission)) {
        const path = requestPath(req);
        logger.warn(
          { userId: identity.user.id, role, permission, method: req.method, path },
          'permission denied',
        );

        // The audit write cannot fail the refusal: `writeAudit` logs and
        // swallows its own errors, so a broken audit store still answers 403.
        await writeAudit({
          userId: identity.user._id,
          action: AUDIT_ACTIONS.PERMISSION_DENIED,
          resourceType: 'route',
          resourceId: `${req.method} ${path}`,
          details: { permission, role, method: req.method, path },
        });

        throw new AppError('PERMISSION_DENIED', undefined, {
          requiredPermission: permission,
          role: role as Role,
        });
      }

      next();
    })().catch(next);
  }) as PermissionGuard;

  Object.defineProperties(guard, {
    guardKind: { value: PERMISSION_GUARD_KIND, enumerable: true },
    permission: { value: permission, enumerable: true },
  });

  return guard;
}
