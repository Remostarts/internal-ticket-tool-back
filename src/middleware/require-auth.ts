import type { Request, RequestHandler } from 'express';
import type { Role } from '@/shared';
import { logger } from '../logging/logger.js';
import { User, type UserDocument } from '../models/user.js';
import type { SessionDocument } from '../models/session.js';
import { AppError } from './error-handler.js';
import { requestPath } from './request-logger.js';
import {
  clearSessionCookie,
  readSessionToken,
  resolveSession,
  revokeSession,
  setSessionCookie,
} from '../services/session.js';

/**
 * The authentication gate (R002).
 *
 * Every route that needs a person behind it goes through here. The gate is
 * deliberately server-side and total: it verifies the signed cookie, resolves
 * the session document, and loads the *current* user record - not a copy of the
 * role carried in a token - so deactivating somebody or changing their role
 * takes effect on their next request rather than at their next sign-in.
 *
 * Three refusals, all 401 `UNAUTHENTICATED` so a caller learns nothing about
 * which one happened:
 *   - no cookie, or a cookie whose signature does not verify;
 *   - a session that is unknown or past its deadline (the stale cookie is cleared);
 *   - an account that is no longer active (the session is revoked on the spot,
 *     so a deactivation ends every open session as it is used).
 *
 * A database failure is not a refusal: it propagates to the failure handler as
 * 500 `INTERNAL`, because "we could not check" must never be reported as "you
 * are not allowed".
 */

export interface RequestIdentity {
  user: UserDocument;
  session: SessionDocument;
  /** The raw cookie token, needed to revoke exactly this session. */
  token: string;
}

/**
 * What the request logger reads (see `getRequestUser`). Attached as `user` in
 * addition to the full identity so the diagnostic line keeps working unchanged.
 */
export interface RequestUserRef {
  id: string;
  role: Role;
}

export type AuthenticatedRequest = Request & { identity: RequestIdentity; user: RequestUserRef; sessionUser?: UserDocument };

declare global {
  namespace Express {
    interface Request {
      identity?: RequestIdentity;
      user?: RequestUserRef;
      sessionUser?: UserDocument;
    }
  }
}

export const requireAuth: RequestHandler = (req, res, next) => {
  void (async (): Promise<void> => {
    const token = readSessionToken(req);
    if (!token) {
      throw new AppError('UNAUTHENTICATED');
    }

    const resolved = await resolveSession(token);
    if (!resolved) {
      // A cookie we cannot resolve is worth removing: it will never work again.
      clearSessionCookie(res);
      throw new AppError('UNAUTHENTICATED');
    }

    const user = await User.findById(resolved.session.user);
    if (!user) {
      await revokeSession(token);
      clearSessionCookie(res);
      throw new AppError('UNAUTHENTICATED');
    }

    if (!user.active) {
      logger.warn(
        { userId: String(user._id), path: requestPath(req) },
        'refused: the account is not active; the session was revoked',
      );
      await revokeSession(token);
      clearSessionCookie(res);
      throw new AppError('UNAUTHENTICATED');
    }

    if (resolved.refreshed) {
      // The server pushed the deadline forward, so the browser's copy has to
      // move with it or the cookie would expire while the session is still live.
      setSessionCookie(res, token, resolved.session.expiresAt);
    }

    const authenticated = req as AuthenticatedRequest;
    authenticated.user = { id: String(user._id), role: user.role as Role };
    authenticated.identity = { user, session: resolved.session, token };
    authenticated.sessionUser = user;
    next();
  })().catch(next);
};
