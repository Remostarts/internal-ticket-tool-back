import { env } from '../config/env.js';
import { databaseState } from '../db/connect.js';
import { logger } from '../logging/logger.js';
import { User } from '../models/user.js';
import { hashPassword } from './password.js';

/**
 * The administrator seed (R008).
 *
 * There is no public sign-up, so a fresh install has exactly one way in: the
 * account described by `SEED_ADMIN_*`. The seed runs on every boot and is
 * idempotent and non-destructive - if the address already exists it is left
 * completely alone, password included. That is the difference between "the
 * deployment can always be entered" and "restarting the API resets the
 * administrator's password to whatever is in the environment".
 *
 * It never throws at the caller for a duplicate: a race with another instance
 * booting at the same moment is a skip, not a crash loop.
 */

export interface SeedAdminResult {
  created: boolean;
  email: string;
  /** Why nothing was created, when nothing was. */
  reason?: 'already_exists' | 'database_unavailable' | 'username_conflict';
  username?: string;
}

/** A username worth showing, derived from the address because there is no field for it. */
export function deriveUsername(email: string): string {
  const local = email.split('@')[0] ?? '';
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 40);
  return cleaned.length >= 3 ? cleaned : 'admin';
}

/** The first free `base`, `base-2`, `base-3` … so a taken name cannot make boot fail. */
async function firstFreeUsername(base: string): Promise<string | null> {
  for (let suffix = 0; suffix < 10; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
    const taken = await User.exists({ username: candidate });
    if (!taken) {
      return candidate;
    }
  }
  return null;
}

export async function seedAdmin(): Promise<SeedAdminResult> {
  const email = env.SEED_ADMIN_EMAIL;

  if (!email || !env.SEED_ADMIN_PASSWORD || !env.SEED_ADMIN_NAME) {
    logger.info('administrator seed skipped: missing SEED_ADMIN_* environment variables');
    return { created: false, email: email ?? 'skipped', reason: 'already_exists' };
  }

  if (databaseState() !== 'connected') {
    logger.warn({ email }, 'administrator seed skipped: the database is unavailable');
    return { created: false, email, reason: 'database_unavailable' };
  }

  const existing = await User.exists({ email });
  if (existing) {
    logger.info({ email }, 'administrator seed skipped: the account already exists');
    return { created: false, email, reason: 'already_exists' };
  }

  const username = await firstFreeUsername(deriveUsername(email));
  if (!username) {
    logger.error({ email }, 'administrator seed failed: no free username could be derived');
    writeSeedFailureAudit(email);
    return { created: false, email, reason: 'username_conflict' };
  }

  try {
    await User.create({
      email,
      username,
      passwordHash: await hashPassword(env.SEED_ADMIN_PASSWORD),
      role: 'admin',
      active: true,
      // The configured password is a bootstrap secret, not a chosen one: the
      // first sign-in forces a real password (see the open question in
      // 01-CONTEXT.md, which defaults to exactly this).
      mustChangePassword: true,
      profile: { fullName: env.SEED_ADMIN_NAME },
    });
  } catch (error) {
    // Only a duplicate key can land here in practice (another instance won the
    // race); anything else is logged and rethrown so it is not silently lost.
    if ((error as { code?: number }).code === 11000) {
      logger.info({ email }, 'administrator seed skipped: created concurrently');
      return { created: false, email, reason: 'already_exists' };
    }
    throw error;
  }

  logger.info({ email, username }, 'administrator seeded: sign in and change the password');
  return { created: true, email, username };
}

function writeSeedFailureAudit(email: string): void {
  // Deliberately just a log line: the audit writer needs a database, and the
  // case that got us here is a database that is reachable but conflicting.
  logger.error({ email }, 'administrator seed could not create the account');
}
