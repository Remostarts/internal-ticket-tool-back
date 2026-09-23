import { Router, type Request, type Response } from 'express';
import { forgotPasswordSchema, resetPasswordSchema } from '@/shared';
import { env } from '../config/env.js';
import { logger } from '../logging/logger.js';
import { AppError, asyncHandler } from '../middleware/error-handler.js';
import { createRateLimit, type RateLimitOptions } from '../middleware/rate-limit.js';
import { AUDIT_ACTIONS } from '../models/audit-log.js';
import { Session } from '../models/session.js';
import { User } from '../models/user.js';
import { writeAudit } from '../services/audit.js';
import {
  buildPasswordResetUrl,
  createMailer,
  maskEmail,
  renderPasswordResetEmail,
  type Mailer,
} from '../services/mail.js';
import { hashPassword } from '../services/password.js';
import { hashResetToken } from '../models/password-reset-token.js';
import { consumeResetToken, issueResetToken } from '../services/password-reset.js';

/**
 * Self-service password recovery (R014, and the recovery half of R015).
 *
 * Two public routes, and both are shaped by the same worry: a signed-out caller
 * is a stranger, so the surface must be, in order of importance,
 *
 *   - **unable to enumerate accounts.** `POST /api/auth/password/forgot` answers
 *     the same `200 { requested: true }` for a known address, an unknown address
 *     and a delivery failure. The one exception is an installation with no mail
 *     transport at all, which answers `503 MAIL_NOT_CONFIGURED` *before* any
 *     lookup - a plain "recovery is not available here" rather than a body that
 *     would have to be a lie;
 *   - **unable to spend a link twice.** `POST /api/auth/password/reset` consumes
 *     the token atomically (see `services/password-reset.ts`) and turns every
 *     refusal - unknown, malformed, expired, reused, inactive account - into one
 *     identical `VALIDATION_FAILED` message beside the `token` field;
 *   - **never carrying a secret.** The raw token and the reset URL are never
 *     logged and never audited; the warn line names the user id and a masked
 *     address, and the audit detail carries only the first eight characters of
 *     the token digest.
 *
 * The whole forget handler is wrapped so a failure inside the mailer cannot
 * escape as a 500 that would tell the caller the address was real; the operator
 * sees the error, the stranger sees the same body as everybody else.
 *
 * A successful reset ends every session the account had open. That is the point
 * of a reset: the whole reason somebody uses it is that they believe their
 * password is in somebody else's hands, and a live cookie would keep that
 * somebody in.
 */

/** The one refusal a bad or spent reset link gets, so the reasons stay indistinguishable. */
const REFUSED_RESET_LINK = 'That password reset link is no longer valid. Request a new one.';

export interface PasswordResetRouterOptions {
  /** Overrides the configured mailer; a test supplies a capturing or refusing one. */
  mailer?: Mailer;
  /** Injected clock, so a test can place a link deliberately in the past. */
  now?: () => Date;
  /**
   * The limiter on the forgot route. Defaults to `AUTH_FORGOT_RATE_MAX` per
   * `AUTH_FORGOT_RATE_WINDOW_MINUTES`; `false` removes it for a test that is
   * exercising something else.
   */
  forgotRateLimit?: RateLimitOptions | false;
}

/** The unchanged body every forgot outcome carries, so callers cannot compare branches. */
interface ForgotResponse {
  requested: true;
}

function resetLinkRefused(): AppError {
  return new AppError('VALIDATION_FAILED', REFUSED_RESET_LINK, {
    fields: [{ path: 'token', message: REFUSED_RESET_LINK }],
  });
}

export function createPasswordResetRouter(options: PasswordResetRouterOptions = {}): Router {
  const router = Router();
  const mailer = options.mailer ?? createMailer();
  const now = options.now ?? (() => new Date());

  const forgotLimiter =
    options.forgotRateLimit === false
      ? null
      : createRateLimit(
          options.forgotRateLimit ?? {
            name: 'auth-forgot',
            windowMs: env.AUTH_FORGOT_RATE_WINDOW_MINUTES * 60_000,
            max: env.AUTH_FORGOT_RATE_MAX,
          },
        ).handler;

  const forgot = async (req: Request, res: Response): Promise<void> => {
    const input = forgotPasswordSchema.parse(req.body);
    const at = now();

    // No transport means no link can be delivered, ever. Answering the
    // encouraging body for a message that cannot be sent would be a lie, so the
    // route says plainly that recovery is unavailable - and it says so before
    // any account lookup, so the answer is the same for every address.
    if (mailer.transport === 'none') {
      throw new AppError('MAIL_NOT_CONFIGURED');
    }

    const user = await User.findOne({ email: input.email });

    const answer: ForgotResponse = { requested: true };

    if (!user || !user.active) {
      // An unauthenticated caller does not get to learn which addresses exist.
      res.status(200).json(answer);
      return;
    }

    const masked = maskEmail(user.email);
    try {
      const { rawToken } = await issueResetToken({
        userId: String(user._id),
        ip: req.ip ?? null,
        now: at,
      });
      const message = renderPasswordResetEmail({
        fullName: user.profile?.fullName || user.username,
        resetUrl: buildPasswordResetUrl(rawToken),
        expiresInMinutes: env.RESET_TOKEN_MINUTES,
      });

      // Recorded before delivery is attempted: the request happened whether or
      // not the message leaves, and an operator tracing "no mail arrived" needs
      // to see it. The detail carries no token and no URL.
      logger.warn({ userId: String(user._id), email: masked }, 'password reset requested');
      await writeAudit({
        userId: user._id,
        action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
        resourceType: 'user',
        resourceId: String(user._id),
        details: { method: 'email' },
      });

      try {
        await mailer.send({
          to: user.email,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
      } catch (error) {
        // Delivery failing must not change the answer, and must not become a
        // 500 that would reveal the address exists. The operator sees it.
        logger.error({ userId: String(user._id), email: masked, err: error }, 'password reset mail could not be sent');
      }
    } catch (error) {
      logger.error({ userId: String(user._id), email: masked, err: error }, 'password reset could not be issued');
    }

    res.status(200).json(answer);
  };

  const reset = async (req: Request, res: Response): Promise<void> => {
    const input = resetPasswordSchema.parse(req.body);
    const at = now();
    // Only the digest prefix identifies the attempt in the audit trail; the raw
    // token is not written down anywhere on this path.
    const tokenHashPrefix = hashResetToken(input.token).slice(0, 8);

    const spent = await consumeResetToken(input.token, at);
    if (!spent) {
      throw resetLinkRefused();
    }

    const user = await User.findById(spent.user);
    if (!user || !user.active) {
      // The token was real but the account is gone or barred. Same refusal as
      // any other dead link - no "this account is deactivated" hint.
      throw resetLinkRefused();
    }

    user.passwordHash = await hashPassword(input.password);
    user.mustChangePassword = false;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await user.save();

    // Every session the account had open ends here: whoever held the old
    // password must not keep a live cookie, which is the whole point of a reset.
    await Session.deleteMany({ user: user._id });

    await writeAudit({
      userId: user._id,
      action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
      resourceType: 'user',
      resourceId: String(user._id),
      details: { tokenHashPrefix },
    });

    res.status(200).json({ reset: true });
  };

  // The limiter sits in front of the route, not inside it, so a refused request
  // never reaches the account lookup or the mailer.
  if (forgotLimiter) {
    router.post('/api/auth/password/forgot', forgotLimiter, asyncHandler(forgot));
  } else {
    router.post('/api/auth/password/forgot', asyncHandler(forgot));
  }
  router.post('/api/auth/password/reset', asyncHandler(reset));

  return router;
}
