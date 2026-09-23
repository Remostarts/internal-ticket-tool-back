import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { permissionsForRole, type Permission, type Role } from '@/shared';
import { env } from '../config/env.js';
import { Session, type SessionDocument } from '../models/session.js';
import type { UserDocument } from '../models/user.js';

/**
 * The session lifecycle (R002, D003).
 *
 * A session is a document in MongoDB referenced by a signed, httpOnly cookie:
 *
 *   - the cookie carries 32 random bytes, and only their SHA-256 digest is
 *     stored, so a dumped database cannot be replayed as a pile of live cookies;
 *   - the cookie is signed, so an edited cookie fails before it reaches a query;
 *   - the life is roughly 30 days and *idle-refreshed*: a request that arrives
 *     after the session has been quiet for an hour pushes the deadline forward,
 *     so somebody who uses the app daily is never signed out mid-work, and the
 *     cookie is re-issued at the same moment so the browser's copy agrees with
 *     the server's.
 *
 * The `user` field is the actor. It is a real reference, not a copy of the role,
 * so a role change takes effect on the next request instead of the next sign-in.
 */

export const SESSION_COOKIE_NAME = 'cd_session';

/** Roughly 30 days, per the milestone's technical constraints. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How stale a session must be before it is rolled forward. */
export const SESSION_ROLL_AFTER_MS = 60 * 60 * 1000;

/** The stored form of a token. The raw token exists only in the cookie and in memory. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreateSessionInput {
  userId: string;
  userAgent?: string | null;
  ip?: string | null;
}

export interface MintedSession {
  token: string;
  expiresAt: Date;
}

export async function createSession(input: CreateSessionInput): Promise<MintedSession> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await Session.create({
    tokenHash: hashSessionToken(token),
    user: input.userId,
    lastSeenAt: new Date(),
    expiresAt,
    userAgent: input.userAgent?.slice(0, 500) ?? null,
    ip: input.ip ?? null,
  });

  return { token, expiresAt };
}

export interface ResolvedSession {
  session: SessionDocument;
  /** True when this request rolled the deadline forward, so the caller re-issues the cookie. */
  refreshed: boolean;
}

/**
 * Resolves a raw cookie token to its live session, or null.
 *
 * An expired document is deleted rather than waited on: the TTL monitor runs
 * about once a minute and "expired" has to mean expired now.
 */
export async function resolveSession(token: string): Promise<ResolvedSession | null> {
  const session = await Session.findOne({ tokenHash: hashSessionToken(token) });
  if (!session) {
    return null;
  }

  const now = new Date();
  if (session.expiresAt.getTime() <= now.getTime()) {
    await Session.deleteOne({ _id: session._id });
    return null;
  }

  if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_ROLL_AFTER_MS) {
    session.lastSeenAt = now;
    session.expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await session.save();
    return { session, refreshed: true };
  }

  return { session, refreshed: false };
}

/** Ends one session by its raw token. True when a document was actually removed. */
export async function revokeSession(token: string): Promise<boolean> {
  const result = await Session.deleteOne({ tokenHash: hashSessionToken(token) });
  return (result.deletedCount ?? 0) > 0;
}

/** The cookie's raw token, or null. A failed signature arrives as `false` and is treated as absent. */
export function readSessionToken(req: Request): string | null {
  const signed = (req as Request & { signedCookies?: Record<string, unknown> }).signedCookies;
  const value = signed?.[SESSION_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Writes the session cookie. `signed: true` requires `cookieParser(secret)` to
 * have run - without a secret `res.cookie` throws, which is the correct failure
 * for "the session secret is missing", not a cookie anybody can forge.
 */
export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.max(0, expiresAt.getTime() - Date.now()),
  });
}

/** Same attributes as the writer, or the browser keeps the old cookie. */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
  });
}

/**
 * What a signed-in caller is told about themselves.
 *
 * One shape for `POST /api/auth/login` and `GET /api/auth/me` (and for S02's
 * Google sign-in), so the web shell has a single session type: the identity, the
 * resolved permission list the navigation filters on, and the flag that drives
 * the forced password change after first boot.
 */
export interface SessionUser {
  id: string;
  email: string;
  username: string;
  role: Role;
  permissions: readonly Permission[];
  mustChangePassword: boolean;
  profile: {
    fullName: string;
    department: string;
    phone: string;
    bio: string;
    pictureUrl: string | null;
  };
  lastLoginAt: Date | null;
}

export function describeSessionUser(user: UserDocument): SessionUser {
  return {
    id: String(user._id),
    email: user.email,
    username: user.username,
    role: user.role as Role,
    permissions: permissionsForRole(user.role as Role),
    mustChangePassword: user.mustChangePassword,
    profile: {
      fullName: user.profile?.fullName ?? '',
      department: user.profile?.department ?? '',
      phone: user.profile?.phone ?? '',
      bio: user.profile?.bio ?? '',
      pictureUrl: user.profile?.pictureUrl ?? null,
    },
    lastLoginAt: user.lastLoginAt ?? null,
  };
}
