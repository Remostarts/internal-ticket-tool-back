import { env } from '../config/env.js';

/**
 * Account lockout (R015).
 *
 * The rate limiter in `middleware/rate-limit.ts` blunts a fast flood from one
 * address, but it is per client key and per process, so a slow guessing run -
 * one attempt every few minutes, from wherever - walks straight through it. The
 * account itself therefore has to lock: after `AUTH_LOCKOUT_THRESHOLD`
 * consecutive failures the password path refuses everything for
 * `AUTH_LOCKOUT_MINUTES`, and the refusal says how long the wait is.
 *
 * Four deliberate properties, each of which a future change must preserve:
 *
 *   - **The lock is temporary, not a dead account.** `lockedUntil` is a deadline,
 *     so the person recovers by waiting rather than by telephoning support, and
 *     there is no administrative "unlock" step that could be forgotten. Support
 *     can still clear the field by hand if a lock is abused.
 *   - **The counter is per account, not per IP.** An attacker who changes address
 *     between attempts still burns the same budget, and a shared office address
 *     cannot lock somebody else out by failing to sign in.
 *   - **An unknown address never locks anything.** These helpers only ever run
 *     for a user document the caller already loaded, so a stranger cannot create
 *     a lock (or a document) by guessing at addresses.
 *   - **A lock covers the password path only.** Nothing here is consulted by the
 *     Google path, so an attacker who knows an address cannot lock its owner out
 *     of the credential they actually use to sign in.
 *
 * These are pure mutations over a document's fields: each helper writes the
 * fields and hands back what happened, and **never saves**. The caller owns the
 * transaction boundary, because only the caller knows whether the attempt was
 * part of a refusal that also wrote an audit entry.
 */

/** The two fields these helpers read and write. Kept structural so the document type satisfies it. */
export interface LockoutState {
  failedLoginAttempts: number;
  lockedUntil?: Date | null;
}

/** Consecutive failures that lock the account, from the validated environment. */
export function lockoutThreshold(): number {
  return env.AUTH_LOCKOUT_THRESHOLD;
}

/** How long a fresh lock lasts, from the validated environment. */
export function lockoutDurationMs(): number {
  return env.AUTH_LOCKOUT_MINUTES * 60_000;
}

/** True only while the deadline is still in the future; an expired lock is simply not a lock. */
export function isLocked(user: LockoutState, now: Date = new Date()): boolean {
  return user.lockedUntil != null && user.lockedUntil.getTime() > now.getTime();
}

/** Milliseconds left on the lock, or `0` when the account is not locked. */
export function remainingLockMs(user: LockoutState, now: Date = new Date()): number {
  if (!isLocked(user, now)) {
    return 0;
  }
  return (user.lockedUntil as Date).getTime() - now.getTime();
}

/** What one failed attempt did to the document. */
export interface FailedAttemptOutcome {
  /** True when *this* attempt was the one that crossed the threshold. */
  locked: boolean;
  /** The consecutive-failure count this attempt reached (the threshold itself when it locked). */
  attempts: number;
  /** The deadline that was just set, or `null` when the account did not lock. */
  lockedUntil: Date | null;
}

/**
 * Records one failed sign-in.
 *
 * The count increments, and when it reaches the threshold the deadline is set
 * and the counter is reset to 0 - so the *next* window starts clean and a person
 * who eventually signs in does not carry their earlier failures into it. The
 * document is mutated, never saved.
 */
export function registerFailedAttempt(
  user: LockoutState,
  now: Date = new Date(),
): FailedAttemptOutcome {
  user.failedLoginAttempts += 1;
  const attempts = user.failedLoginAttempts;

  if (attempts < env.AUTH_LOCKOUT_THRESHOLD) {
    return { locked: false, attempts, lockedUntil: null };
  }

  const lockedUntil = new Date(now.getTime() + lockoutDurationMs());
  user.failedLoginAttempts = 0;
  user.lockedUntil = lockedUntil;

  return { locked: true, attempts, lockedUntil };
}

/**
 * Forgets the failures and clears any lock.
 *
 * Called on a successful sign-in. Clearing `lockedUntil` here is safe because a
 * live lock is refused before the password is ever compared, so a success can
 * only happen at or after the deadline - and an elapsed lock should not linger
 * on the document where a support query would mistake it for a current one.
 */
export function clearFailedAttempts(user: LockoutState): void {
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
}
