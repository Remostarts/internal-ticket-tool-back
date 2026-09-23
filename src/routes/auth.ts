import { Router } from 'express';
import { loginSchema } from '@/shared';
import { env } from '../config/env.js';
import { logger } from '../logging/logger.js';
import { AppError, asyncHandler } from '../middleware/error-handler.js';
import { createRateLimit, type RateLimitOptions } from '../middleware/rate-limit.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/require-auth.js';
import { AUDIT_ACTIONS } from '../models/audit-log.js';
import { User } from '../models/user.js';
import { writeAudit } from '../services/audit.js';
import type { GoogleVerifier } from '../services/google.js';
import {
  clearFailedAttempts,
  isLocked,
  registerFailedAttempt,
  remainingLockMs,
} from '../services/lockout.js';
import { DUMMY_PASSWORD_HASH, hashPassword, needsRehash, verifyPassword } from '../services/password.js';
import {
  clearSessionCookie,
  createSession,
  describeSessionUser,
  revokeSession,
  setSessionCookie,
} from '../services/session.js';

/**
 * Email and password sign-in (R001, R002, R008, R015).
 *
 * Mounted under `/api/auth/*` because that is the path the browser actually
 * reaches: the Next.js rewrite forwards `/api/:path*` to the API with the prefix
 * intact, so a route declared as `/auth/login` would be unreachable from the
 * browser.
 *
 * The sign-in refusal is the delicate part. An unknown email, a wrong password
 * and a deactivated account all leave as one identical `401 INVALID_CREDENTIALS`
 * with one identical message, and all three spend the same bcrypt work - the
 * unknown-email case compares against `DUMMY_PASSWORD_HASH` - so neither the
 * body nor the response time tells a caller which accounts exist. The *reason*
 * is recorded in the audit trail and in the log, where only operators can see it.
 *
 * Two brute-force defences sit here, and they cover different attacks:
 *
 *   - **A per-address rate limit** (first handler on the route, from T02) blunts
 *     a fast flood. It has no database access, so it cannot be used to add load
 *     to the account store it protects.
 *   - **A per-account lock** (`services/lockout.ts`) catches the slow run that
 *     walks straight through a per-address window: after
 *     `AUTH_LOCKOUT_THRESHOLD` consecutive failures the account refuses even a
 *     *correct* password until `lockedUntil` passes, and says how long that is.
 *     A locked account never reaches bcrypt, so the lock cannot be used to make
 *     the server do work, and the lock covers this password path only - the
 *     Google path never consults it, so nobody can lock another person out of
 *     the credential they actually use.
 *
 * The locked refusal is deliberately specific ("locked for about N more
 * minute(s)"), the one message here that admits the account exists. Its only
 * reader is somebody who already proved they know the address, and answering
 * "invalid credentials" would leave them retrying a form that cannot succeed.
 * The account-existence refusal for an unknown address is unchanged.
 */

export interface AuthRouterOptions {
  /**
   * The limiter on the sign-in route. Defaults to `AUTH_LOGIN_RATE_MAX` per
   * `AUTH_LOGIN_RATE_WINDOW_MINUTES`; `false` removes it for a test that is
   * exercising something else, and a `RateLimitOptions` replaces it so a test
   * can drive the window with an injected clock.
   */
  loginRateLimit?: RateLimitOptions | false;
  /**
   * Injected clock, so a test can push time past a lockout deadline. Shared with
   * the password-recovery and Google routers through `createApp`'s `auth` option
   * bag.
   */
  now?: () => Date;
  /**
   * The Google verifier seam. Production passes nothing and the router builds
   * the real verifier from `env`; a test hands in a stub so the callback
   * contract is provable without Google credentials and without a network call.
   */
  google?: { verifier?: GoogleVerifier };
}

export function createAuthRouter(options: AuthRouterOptions = {}): Router {
  const router = Router();
  const now = options.now ?? (() => new Date());

  const loginLimiter =
    options.loginRateLimit === false
      ? null
      : createRateLimit(
          options.loginRateLimit ?? {
            name: 'auth-login',
            windowMs: env.AUTH_LOGIN_RATE_WINDOW_MINUTES * 60_000,
            max: env.AUTH_LOGIN_RATE_MAX,
          },
        ).handler;

  const login = asyncHandler(async (req, res) => {
    // The shared schema is the same one the form uses, so the two cannot drift.
    const input = loginSchema.parse(req.body);
    const at = now();

    // Loaded with `+passwordHash` because the success path needs it; a locked
    // account stops here, before any bcrypt work, so a lock costs one query.
    const user = await User.findOne({ email: input.email }).select('+passwordHash');

    // A live lock is only consulted for an active account: a deactivated person
    // gets the ordinary identical refusal, never a hint that a lock exists.
    if (user && user.active && isLocked(user, at)) {
      const remainingMs = remainingLockMs(user, at);
      const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
      const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));

      logger.warn(
        { userId: String(user._id), retryAfterSeconds },
        'sign-in refused while the account is locked',
      );
      await writeAudit({
        userId: user._id,
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        resourceType: 'user',
        resourceId: String(user._id),
        details: { method: 'password', reason: 'locked' },
      });

      // The machine-readable hint travels beside the body, exactly as the rate
      // limiter does it, so the two refusals read the same to a client.
      res.setHeader('Retry-After', String(retryAfterSeconds));
      throw new AppError(
        'RATE_LIMITED',
        `Too many failed sign-in attempts. This account is locked for about ${minutes} more minute${
          minutes === 1 ? '' : 's'
        }. Try again after that.`,
        { retryAfterSeconds },
      );
    }

    const digest = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const passwordMatches = await verifyPassword(input.password, digest);

    if (!user || !passwordMatches || !user.active) {
      const reason = !user ? 'unknown_email' : !passwordMatches ? 'wrong_password' : 'inactive';
      logger.warn(
        { email: input.email, userId: user ? String(user._id) : null, reason },
        'sign-in refused',
      );
      await writeAudit({
        userId: user?._id ?? null,
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        resourceType: 'user',
        resourceId: user ? String(user._id) : null,
        details: { method: 'password', reason },
      });

      // Only an existing account carries a counter. An unknown address leaves no
      // document behind, so guessing at addresses cannot create - or lock - one.
      if (user) {
        const outcome = registerFailedAttempt(user, at);
        await user.save();

        if (outcome.locked) {
          logger.warn(
            {
              userId: String(user._id),
              attempts: outcome.attempts,
              lockedUntil: outcome.lockedUntil,
            },
            'account locked after repeated failed sign-ins',
          );
          await writeAudit({
            userId: user._id,
            action: AUDIT_ACTIONS.ACCOUNT_LOCKED,
            resourceType: 'user',
            resourceId: String(user._id),
            details: { attempts: outcome.attempts, lockedUntil: outcome.lockedUntil },
          });
        }
      }

      throw new AppError('INVALID_CREDENTIALS');
    }

    // A digest written at an older cost is upgraded while the plaintext is in
    // hand; the person never learns this happened.
    if (needsRehash(user.passwordHash)) {
      user.passwordHash = await hashPassword(input.password);
    }

    clearFailedAttempts(user);
    user.lastLoginAt = at;
    await user.save();

    const { token, expiresAt } = await createSession({
      userId: String(user._id),
      userAgent: req.get('user-agent') ?? null,
      ip: req.ip ?? null,
    });
    setSessionCookie(res, token, expiresAt);

    await writeAudit({
      userId: user._id,
      action: AUDIT_ACTIONS.LOGIN,
      resourceType: 'user',
      resourceId: String(user._id),
      details: { method: 'password' },
    });

    res.status(200).json({ user: describeSessionUser(user) });
  });

  // The limiter sits in front of the route, not inside it, so a refused request
  // never reaches the account lookup or bcrypt.
  if (loginLimiter) {
    router.post('/api/auth/login', loginLimiter, login);
  } else {
    router.post('/api/auth/login', login);
  }

  router.post(
    '/api/auth/logout',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { user, token } = (req as AuthenticatedRequest).identity;

      await revokeSession(token);
      await writeAudit({
        userId: user._id,
        action: AUDIT_ACTIONS.LOGOUT,
        resourceType: 'user',
        resourceId: String(user._id),
      });
      clearSessionCookie(res);

      res.status(200).json({ signedOut: true });
    }),
  );

  /**
   * Who the caller is, as the server sees them.
   *
   * The permission list is resolved here rather than computed in the browser:
   * the web shell filters its navigation on the same keys this route enforces,
   * so a menu entry and the route behind it cannot disagree (R004).
   */
  router.get('/api/auth/me', requireAuth, (req, res) => {
    const { user } = (req as AuthenticatedRequest).identity;
    res.status(200).json({ user: describeSessionUser(user) });
  });

  return router;
}
