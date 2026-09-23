import { Router, type Request, type Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../logging/logger.js';
import { asyncHandler } from '../middleware/error-handler.js';
import { AUDIT_ACTIONS } from '../models/audit-log.js';
import { User } from '../models/user.js';
import { writeAudit } from '../services/audit.js';
import {
  createGoogleState,
  createGoogleVerifier,
  defaultGoogleRedirectUri,
  googleCallbackCookieClearOptions,
  googleCallbackCookieNames,
  googleCallbackCookieOptions,
  pkceChallenge,
  createPkceVerifier,
  type GoogleIdentity,
  type GoogleVerifier,
} from '../services/google.js';
import { createSession, describeSessionUser, setSessionCookie } from '../services/session.js';

/**
 * Google sign-in: the browser-facing half (R013).
 *
 * Two public routes and no more, because Google sign-in has to answer a
 * browser, not a fetch:
 *
 *   - `GET /api/auth/google/start` mints a CSRF `state` and a PKCE verifier,
 *     stores both in signed httpOnly cookies, and redirects to Google. With no
 *     client configured it redirects straight back to the login screen with a
 *     written reason instead of starting a consent dance that cannot finish.
 *   - `GET /api/auth/google/callback` is where Google returns. Its authority is
 *     the signed state cookie - not a session, because there is no session yet -
 *     so a caller who fabricates a callback cannot make one.
 *
 * **The refusal contract.** Every failure leaves as a 302 to
 * `${WEB_ORIGIN}/login?error=<code>` where the code is one of five fixed
 * strings. There is deliberately no `next`/`returnTo` parameter anywhere in this
 * slice: a redirect target that came from the request would be an open redirect,
 * so the target is always the configured web origin and only the error code
 * varies. The provider's own error text is never echoed - it is query data
 * supplied by whoever hit the URL.
 *
 * **Landing in the same account as the password path.** The account is found by
 * the lowercased email Google verified, never by the Google subject, and an
 * address with no Claim Desk account is refused (`google_no_account`) rather
 * than created: R008 says there is no public sign-up. The subject is recorded on
 * the account the first time Google is used, and never overwrites a value that
 * is already there. A locked account still signs in this way on purpose - the
 * lock defends the password path, and nobody should be able to lock another
 * person out of the credential they actually use.
 *
 * On success the callback does exactly what the password route does:
 * `createSession`, `setSessionCookie`, one `auth.login` audit entry (with
 * `details.method: 'google'`), and the session that follows is
 * indistinguishable from a password sign-in's. A caller who explicitly accepts
 * JSON gets `{ user }` back; a browser gets the redirect to the app root.
 */

export interface GoogleAuthRouterOptions {
  /** Overrides the real verifier; a test supplies a stub with no network access. */
  verifier?: GoogleVerifier;
  /** Injected clock, shared with the other credential routers through `createApp`. */
  now?: () => Date;
}

/**
 * Every failure code the callback may use. A fixed allowlist, so the redirect
 * can never carry a value chosen by the caller.
 */
export const GOOGLE_FAILURE_CODES = [
  'google_not_configured',
  'google_cancelled',
  'google_failed',
  'google_no_account',
  'google_inactive',
] as const;

export type GoogleFailureCode = (typeof GOOGLE_FAILURE_CODES)[number];

/** The one place a failure target is built: the configured web origin's login screen. */
function loginFailureUrl(code: GoogleFailureCode): string {
  const url = new URL('/login', env.WEB_ORIGIN);
  url.searchParams.set('error', code);
  return url.toString();
}

/** The signed cookie's value, or null. A tampered cookie arrives as `false` and is treated as absent. */
function readSignedCookie(req: Request, name: string): string | null {
  const signed = (req as Request & { signedCookies?: Record<string, unknown> }).signedCookies;
  const value = signed?.[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** True when the caller asked for JSON rather than the browser redirect. */
function wantsJson(req: Request): boolean {
  return req.accepts(['html', 'json']) === 'json';
}

export function createGoogleAuthRouter(options: GoogleAuthRouterOptions = {}): Router {
  const router = Router();
  const verifier = options.verifier ?? createGoogleVerifier();
  const now = options.now ?? (() => new Date());
  const cookies = googleCallbackCookieNames();

  /**
   * The single exit for a failure: log the code (never the code/tokens/verifier)
   * and send the browser back to the login screen it came from.
   */
  const refuse = (res: Response, code: GoogleFailureCode): void => {
    logger.warn({ provider: 'google', code }, 'google sign-in refused');
    res.redirect(302, loginFailureUrl(code));
  };

  router.get('/api/auth/google/start', (_req, res) => {
    if (!verifier.configured) {
      refuse(res, 'google_not_configured');
      return;
    }

    const state = createGoogleState();
    const codeVerifier = createPkceVerifier();
    const redirectUri = defaultGoogleRedirectUri();

    res.cookie(cookies.state, state, googleCallbackCookieOptions());
    res.cookie(cookies.verifier, codeVerifier, googleCallbackCookieOptions());

    logger.info({ provider: 'google' }, 'google sign-in started');
    res.redirect(302, verifier.authorizationUrl({ state, codeChallenge: pkceChallenge(codeVerifier), redirectUri }));
  });

  router.get(
    '/api/auth/google/callback',
    asyncHandler(async (req, res) => {
      const stateCookie = readSignedCookie(req, cookies.state);
      const verifierCookie = readSignedCookie(req, cookies.verifier);

      // One-shot: whichever path follows, the pair is spent on arrival, so a
      // replayed callback fails even if everything else about it was valid.
      res.clearCookie(cookies.state, googleCallbackCookieClearOptions());
      res.clearCookie(cookies.verifier, googleCallbackCookieClearOptions());

      const providerError = typeof req.query.error === 'string' ? req.query.error : null;
      if (providerError) {
        // The one provider error worth naming: the person pressed Cancel.
        refuse(res, providerError === 'access_denied' ? 'google_cancelled' : 'google_failed');
        return;
      }

      const state = typeof req.query.state === 'string' ? req.query.state : null;
      const code = typeof req.query.code === 'string' ? req.query.code : null;

      if (!stateCookie || !verifierCookie || !state || state !== stateCookie) {
        refuse(res, 'google_failed');
        return;
      }
      if (!code) {
        refuse(res, 'google_failed');
        return;
      }

      let identity: GoogleIdentity;
      try {
        identity = await verifier.exchange({
          code,
          codeVerifier: verifierCookie,
          redirectUri: defaultGoogleRedirectUri(),
        });
      } catch {
        // The thrown error may quote Google's response; it is logged nowhere and
        // returned nowhere. The operator gets the fixed code, which is enough to
        // know an exchange failed.
        refuse(res, 'google_failed');
        return;
      }

      if (!identity.emailVerified) {
        // An address Google has not verified is not an identity to match an
        // account on - anybody able to add an unverified address could otherwise
        // claim somebody else's Claim Desk user.
        refuse(res, 'google_failed');
        return;
      }

      const email = identity.email.trim().toLowerCase();
      const user = await User.findOne({ email });
      if (!user) {
        // Never create one: R008 says there is no public sign-up.
        refuse(res, 'google_no_account');
        return;
      }
      if (!user.active) {
        refuse(res, 'google_inactive');
        return;
      }

      const at = now();
      // Recorded once, on the first Google sign-in. It is not the matching key,
      // so an account that already has a subject keeps it.
      if (!user.googleId) {
        user.googleId = identity.subject;
      }
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
        details: { method: 'google' },
      });

      if (wantsJson(req)) {
        res.status(200).json({ user: describeSessionUser(user) });
        return;
      }

      // Always the configured origin: there is no caller-supplied return target.
      res.redirect(302, new URL('/', env.WEB_ORIGIN).toString());
    }),
  );

  return router;
}
