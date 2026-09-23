import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions } from 'express';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.js';

/**
 * Google sign-in verification (R013).
 *
 * The whole external identity provider is behind one small interface,
 * `GoogleVerifier`, so the callback contract - state, PKCE, "an unverified
 * address is not an identity", "an unknown address never creates an account" -
 * is provable without Google credentials and without a network call. Production
 * builds the real verifier; a test hands the router a stub.
 *
 * **Identity, not account creation.** The verifier answers "who does Google say
 * this is". It never touches the database and never decides whether that person
 * has a Claim Desk account - the callback route does, by matching on the
 * lowercased email so a Google sign-in lands in the same account as the password
 * path (R013). The subject is recorded, but it is not the matching key and it is
 * not unique, so a second Google account with the same address cannot mint a
 * second Claim Desk user.
 *
 * **Nothing secret is logged here.** The authorization code, the access/refresh
 * tokens, the ID token and the code verifier all pass through this module and
 * none of them is ever written to a log line; the route logs only its own
 * failure code, which is drawn from a fixed allowlist.
 *
 * The two cookies the flow needs (`cd_google_state`, `cd_google_verifier`) are
 * one-shot and short-lived - ten minutes - and they carry the same signing,
 * `httpOnly`, `sameSite: 'lax'` and production-`secure` attributes as the
 * session cookie, so a forged state or a chopped verifier is rejected by the
 * signature before any comparison happens. The attributes live here, beside the
 * names, so the writer and the clearer cannot drift.
 */

/** What Google told us about the person who just consented. */
export interface GoogleIdentity {
  /** The stable Google subject (`sub`). Recorded, never the matching key. */
  subject: string;
  email: string;
  emailVerified: boolean;
  fullName: string | null;
  pictureUrl: string | null;
}

export interface GoogleAuthorizationInput {
  state: string;
  codeChallenge: string;
  redirectUri: string;
}

export interface GoogleExchangeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface GoogleVerifier {
  /** False when either credential is blank: the flow must then refuse, not guess. */
  readonly configured: boolean;
  /** The URL the browser is sent to. Pure: it mints nothing and calls nothing. */
  authorizationUrl(input: GoogleAuthorizationInput): string;
  /** Redeems the code and verifies the ID token. The only call that touches Google. */
  exchange(input: GoogleExchangeInput): Promise<GoogleIdentity>;
}

export interface GoogleVerifierOptions {
  clientId?: string | null;
  clientSecret?: string | null;
  redirectUri?: string;
}

export const GOOGLE_STATE_COOKIE = 'cd_google_state';
export const GOOGLE_VERIFIER_COOKIE = 'cd_google_verifier';

/** The consent round trip is a matter of seconds; ten minutes is generous. */
export const GOOGLE_CALLBACK_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

/** The two one-shot cookie names, in one place so the writer and the clearer cannot drift apart. */
export function googleCallbackCookieNames(): { state: string; verifier: string } {
  return { state: GOOGLE_STATE_COOKIE, verifier: GOOGLE_VERIFIER_COOKIE };
}

/**
 * The attributes for both callback cookies. `signed: true` requires
 * `cookieParser(secret)` to have run - without a secret `res.cookie` throws,
 * which is the correct failure for "the session secret is missing".
 */
export function googleCallbackCookieOptions(): CookieOptions {
  return {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: GOOGLE_CALLBACK_COOKIE_MAX_AGE_MS,
  };
}

/** The same attributes minus the lifetime, so the browser drops the pair. */
export function googleCallbackCookieClearOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
  };
}

/** A CSRF state value: 32 random bytes, URL-safe. */
export function createGoogleState(): string {
  return randomBytes(32).toString('base64url');
}

/** A PKCE verifier: 43 URL-safe characters, inside the 43-128 range RFC 7636 allows. */
export function createPkceVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** The S256 challenge for a verifier - `base64url(sha256(verifier))`. */
export function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/**
 * Where Google sends the browser back.
 *
 * `GOOGLE_REDIRECT_URI` wins when set, because the registered callback is a URL
 * Google's console knows about and cannot be inferred. The fallback is the API
 * origin's own callback, which is what a single-process development run needs;
 * a deployment that reaches the API through the web origin sets the variable.
 */
export function defaultGoogleRedirectUri(): string {
  return env.GOOGLE_REDIRECT_URI?.trim() || `${env.API_ORIGIN}/api/auth/google/callback`;
}

/**
 * The real verifier. `configured` is false when either credential is blank, and
 * both methods refuse in that state rather than sending a request Google will
 * reject: an unconfigured installation must redirect back to the login screen
 * with a written reason, never start a broken consent dance.
 */
export function createGoogleVerifier(options: GoogleVerifierOptions = {}): GoogleVerifier {
  const clientId = (options.clientId ?? env.GOOGLE_CLIENT_ID ?? '').trim();
  const clientSecret = (options.clientSecret ?? env.GOOGLE_CLIENT_SECRET ?? '').trim();
  const redirectUri = options.redirectUri ?? defaultGoogleRedirectUri();
  const configured = clientId.length > 0 && clientSecret.length > 0;

  // Built on first use, so importing this module never constructs a client and
  // never reads a credential it does not need.
  let client: OAuth2Client | null = null;
  const oauthClient = (): OAuth2Client => {
    if (!configured) {
      throw new Error(
        'Google sign-in is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
      );
    }
    client ??= new OAuth2Client({ clientId, clientSecret });
    return client;
  };

  return {
    configured,

    authorizationUrl(input) {
      return oauthClient().generateAuthUrl({
        // `online` because the API has no offline use for a refresh token: the
        // session cookie is the only thing that has to outlive this request.
        access_type: 'online',
        scope: ['openid', 'email', 'profile'],
        // Always show the chooser, so a shared browser does not silently reuse
        // the wrong Google account.
        prompt: 'select_account',
        state: input.state,
        code_challenge: input.codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
        redirect_uri: input.redirectUri || redirectUri,
      });
    },

    async exchange(input) {
      const oauth = oauthClient();
      const { tokens } = await oauth.getToken({
        code: input.code,
        codeVerifier: input.codeVerifier,
        redirect_uri: input.redirectUri || redirectUri,
      });

      const idToken = tokens.id_token;
      if (!idToken) {
        throw new Error('Google returned no ID token for the authorization code.');
      }

      const ticket = await oauth.verifyIdToken({ idToken, audience: clientId });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email) {
        throw new Error('Google returned no usable identity for the ID token.');
      }

      return {
        subject: payload.sub,
        email: payload.email.trim().toLowerCase(),
        // Only an explicit `true` counts. A missing or false claim is an
        // unverified address, which is not an identity this API will match on.
        emailVerified: payload.email_verified === true,
        fullName: payload.name ?? null,
        pictureUrl: payload.picture ?? null,
      };
    },
  };
}
