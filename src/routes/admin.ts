import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { ROLES, isRole, type Permission, type Role } from '@/shared';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePermission } from '../middleware/require-permission.js';
import { AuditLog } from '../models/audit-log.js';
import { Session } from '../models/session.js';
import { User } from '../models/user.js';

/**
 * The administrator area (R004, R009, R012).
 *
 * Two real routes rather than placeholder handlers, because the permission gate
 * has to be proved against something that actually reads data: a stub that
 * answers `{ok:true}` would pass the same tests while proving nothing about the
 * guard sitting in front of a query.
 *
 *   - `GET /api/admin/audit` (key `audit:read`) - the audit trail, newest first,
 *     paginated, filtered by action or actor. This is the read the Shell's
 *     activity table and the Trail screen both consume.
 *   - `GET /api/admin/overview` (key `admin:access`) - the counts a control room
 *     needs at this stage: users by role, how many are active, how many sessions
 *     are live right now.
 *
 * Both carry `requireAuth` and their own `requirePermission` key, and both are
 * recorded in `route-access.ts` as *not* exempt, so the coverage test in
 * `tests/permission-coverage.test.ts` fails if either guard is removed.
 *
 * Keys used here are the shared `Permission` type, so a typo cannot compile and
 * the web shell's navigation - which filters on the same keys - cannot drift
 * from what the API enforces.
 */

/** Hard cap on a page. The audit collection grows without bound and is the one thing here that could. */
export const AUDIT_PAGE_SIZE_MAX = 100;
export const AUDIT_PAGE_SIZE_DEFAULT = 25;

/** The keys this router enforces, named once so the mount sites and the tests share them. */
export const ADMIN_PERMISSIONS = {
  audit: 'audit:read',
  overview: 'admin:access',
} as const satisfies Record<string, Permission>;

/**
 * Query validation for the trail.
 *
 * `pageSize` is capped rather than merely defaulted: pagination is the thing
 * that keeps one request from asking for the whole collection, and an uncapped
 * `?pageSize=100000` would quietly remove it.
 */
export const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(AUDIT_PAGE_SIZE_MAX).default(AUDIT_PAGE_SIZE_DEFAULT),
  /** Exact action name, e.g. `permission.denied`. Indexed with `timestamp` (R012). */
  action: z.string().trim().min(1).max(120).optional(),
  /** The actor's user id. Indexed with `timestamp` (R012). */
  actor: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{24}$/, 'must be a 24-character user id')
    .optional(),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

interface PopulatedActor {
  _id: Types.ObjectId;
  username?: string | null;
  email?: string | null;
}

/** A lean audit row with `user` populated, as the query below returns it. */
interface LeanAuditRow {
  _id: Types.ObjectId;
  user?: Types.ObjectId | PopulatedActor | null;
  action: string;
  timestamp: Date;
  resourceType?: string | null;
  resourceId?: string | null;
  details?: Record<string, unknown> | null;
}

function isPopulatedActor(value: unknown): value is PopulatedActor {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Types.ObjectId) &&
    '_id' in value
  );
}

/**
 * The wire shape of one audit record.
 *
 * The actor is flattened to `{id, username, email}` so the Trail screen can name
 * a person without a second request, and `timestamp` stays an ISO string because
 * that is what the shared formatter (D009) expects.
 */
function serializeAuditEntry(row: LeanAuditRow): Record<string, unknown> {
  const actor = row.user ?? null;
  return {
    id: row._id.toHexString(),
    action: row.action,
    timestamp: row.timestamp,
    resourceType: row.resourceType ?? null,
    resourceId: row.resourceId ?? null,
    details: row.details ?? {},
    actor: isPopulatedActor(actor)
      ? {
          id: actor._id.toHexString(),
          username: actor.username ?? null,
          email: actor.email ?? null,
        }
      : actor instanceof Types.ObjectId
        ? { id: actor.toHexString(), username: null, email: null }
        : null,
  };
}

export function createAdminRouter(): Router {
  const router = Router();

  router.get(
    '/api/admin/audit',
    requireAuth,
    requirePermission(ADMIN_PERMISSIONS.audit),
    asyncHandler(async (req, res) => {
      const query = auditQuerySchema.parse(req.query);

      const filter: { action?: string; user?: Types.ObjectId } = {};
      if (query.action) {
        filter.action = query.action;
      }
      if (query.actor) {
        filter.user = new Types.ObjectId(query.actor);
      }

      const offset = (query.page - 1) * query.pageSize;
      const [total, rows] = await Promise.all([
        AuditLog.countDocuments(filter).exec(),
        AuditLog.find(filter)
          .sort({ timestamp: -1, _id: -1 })
          .skip(offset)
          .limit(query.pageSize)
          .populate('user', 'username email')
          .lean()
          .exec(),
      ]);

      res.status(200).json({
        entries: (rows as unknown as LeanAuditRow[]).map(serializeAuditEntry),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        hasMore: offset + rows.length < total,
      });
    }),
  );

  router.get(
    '/api/admin/overview',
    requireAuth,
    requirePermission(ADMIN_PERMISSIONS.overview),
    asyncHandler(async (_req, res) => {
      const now = new Date();

      const [total, active, sessionsLive, roleCounts] = await Promise.all([
        User.countDocuments({}).exec(),
        User.countDocuments({ active: true }).exec(),
        // "Live" is the same test the session gate applies: a document whose
        // deadline has not passed. The TTL monitor reaps the rest.
        Session.countDocuments({ expiresAt: { $gt: now } }).exec(),
        User.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$role', count: { $sum: 1 } } }]).exec(),
      ]);

      // Every role is present even when nobody holds it, so a control-room tile
      // reads 0 rather than "undefined" the day a new role is added.
      const usersByRole = Object.fromEntries(ROLES.map((role) => [role, 0])) as Record<Role, number>;
      for (const row of roleCounts) {
        if (isRole(row._id)) {
          usersByRole[row._id] = row.count;
        }
      }

      res.status(200).json({
        users: {
          total,
          active,
          inactive: Math.max(0, total - active),
          byRole: usersByRole,
        },
        sessions: { live: sessionsLive },
        generatedAt: now,
      });
    }),
  );

  router.get(
    '/api/admin/notification-settings',
    requireAuth,
    requirePermission(ADMIN_PERMISSIONS.overview),
    asyncHandler(async (_req, res) => {
      const { getNotificationSettings } = await import('../services/notify.js');
      const settings = await getNotificationSettings();
      res.status(200).json(settings);
    }),
  );

  router.patch(
    '/api/admin/notification-settings',
    requireAuth,
    requirePermission(ADMIN_PERMISSIONS.overview),
    asyncHandler(async (req, res) => {
      const { updateNotificationSettings } = await import('../services/notify.js');
      const updated = await updateNotificationSettings(req.body);
      res.status(200).json(updated);
    }),
  );

  return router;
}
