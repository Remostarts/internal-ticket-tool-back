import bcrypt from 'bcrypt';

/**
 * Password hashing (R001).
 *
 * bcrypt at cost 12, in one place so no call site can pick its own cost. Two
 * details matter beyond hashing:
 *
 *   - `verifyPassword` answers `false` for a malformed or missing digest instead
 *     of throwing. A corrupt hash is a failed sign-in, not a 500 that tells the
 *     caller something interesting about the record.
 *   - `DUMMY_PASSWORD_HASH` exists so the login route can spend the same bcrypt
 *     work for an unknown email as for a known one. Without it, "no such user"
 *     answers in a millisecond and "wrong password" answers in a few hundred,
 *     which turns the sign-in form into an account-existence oracle.
 */

export const BCRYPT_COST = 12;

/** A real cost-12 digest of bytes nobody knows. See the module note. */
export const DUMMY_PASSWORD_HASH =
  '$2b$12$CaQ6h4p/s.uWSxfmyIJF9OwfV6EDr9G1Il1xRpUdG/0VtF0rqXcK.';

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

/** True only for a digest that verifies. A malformed digest is simply not a match. */
export async function verifyPassword(plaintext: string, digest: string | null | undefined): Promise<boolean> {
  if (!digest) {
    return false;
  }
  try {
    return await bcrypt.compare(plaintext, digest);
  } catch {
    return false;
  }
}

/**
 * The cost recorded inside a digest, or null when the digest is not one we can
 * read. Later slices use this on sign-in to upgrade a hash written at an older
 * cost without asking the person to do anything.
 */
export function passwordCost(digest: string): number | null {
  const match = /^\$2[aby]?\$(\d{2})\$/.exec(digest);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

/** True when this digest should be replaced on the next successful sign-in. */
export function needsRehash(digest: string): boolean {
  const cost = passwordCost(digest);
  return cost === null || cost < BCRYPT_COST;
}
