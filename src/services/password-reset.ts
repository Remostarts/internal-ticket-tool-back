import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import {
  PasswordResetToken,
  hashResetToken,
  type PasswordResetTokenDocument,
} from '../models/password-reset-token.js';

/**
 * Issuing and consuming password-reset links (R014).
 *
 * A reset link is a single-use bearer credential, so this module is built
 * around two promises that the *store* enforces rather than careful call sites:
 *
 *   - **Only the digest is stored.** `issueResetToken` returns the raw token to
 *     the one caller that puts it in an email; `PasswordResetToken` holds the
 *     SHA-256 digest, so a dumped database is not a pile of working links.
 *   - **A token can be spent exactly once.** `consumeResetToken` spends it with
 *     one atomic `findOneAndUpdate` whose filter includes `usedAt: null` and a
 *     live `expiresAt`. Two requests following the same link at the same moment
 *     cannot both win, and there is no read-then-write window for a replay to
 *     slip through. The same call therefore answers "unknown", "expired" and
 *     "already used" as one indistinguishable `null`, which is exactly what the
 *     route needs to refuse them identically.
 *
 * `issueResetToken` also keeps only one live link per account: a second request
 * supersedes the earlier unused token instead of leaving two working links in
 * somebody's mailbox.
 */

export const RESET_TOKEN_BYTES = 32;

/** How long a freshly issued link stays usable, from the validated environment. */
export function resetTokenTtlMs(): number {
  return env.RESET_TOKEN_MINUTES * 60_000;
}

export interface IssueResetTokenInput {
  userId: string;
  ip?: string | null;
  /** Injected clock, so a test can place a link deliberately in the past. */
  now?: Date;
}

export interface IssuedResetToken {
  /** The value that goes into the email. Never stored, never logged. */
  rawToken: string;
  expiresAt: Date;
  documentId: string;
}

/**
 * Mints a link for `userId` and records its digest.
 *
 * Before creating the new token two clean-ups run for the same account: any
 * unused token that has already expired is deleted (the TTL monitor runs about
 * once a minute, and this makes "expired" true immediately), and any remaining
 * unused token is marked used - so requesting a second link does not leave the
 * first one alive.
 */
export async function issueResetToken(input: IssueResetTokenInput): Promise<IssuedResetToken> {
  const now = input.now ?? new Date();
  const rawToken = randomBytes(RESET_TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(now.getTime() + resetTokenTtlMs());

  await PasswordResetToken.deleteMany({
    user: input.userId,
    usedAt: null,
    expiresAt: { $lte: now },
  });
  await PasswordResetToken.updateMany(
    { user: input.userId, usedAt: null },
    { $set: { usedAt: now } },
  );

  const created = await PasswordResetToken.create({
    user: input.userId,
    tokenHash: hashResetToken(rawToken),
    expiresAt,
    requestedIp: input.ip ?? null,
  });

  return { rawToken, expiresAt, documentId: String(created._id) };
}

/**
 * Spends a raw token, or returns `null`.
 *
 * One atomic step: the filter demands an unused, unexpired token and the update
 * marks it used. A caller cannot tell *why* a token was refused, and must not
 * try - the route turns every `null` into the same written refusal.
 */
export async function consumeResetToken(
  rawToken: string,
  now: Date = new Date(),
): Promise<PasswordResetTokenDocument | null> {
  return PasswordResetToken.findOneAndUpdate(
    { tokenHash: hashResetToken(rawToken), usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: true },
  );
}
