import { pathToFileURL } from 'node:url';
import type { Role } from '@/shared';
import { env } from '../config/env.js';
import { connectDatabase, disconnect } from '../db/connect.js';
import { logger } from '../logging/logger.js';
import { Project } from '../models/project.js';
import { Session } from '../models/session.js';
import { User } from '../models/user.js';
import { hashPassword } from '../services/password.js';
import { createProject } from '../services/projects.js';
import { deriveUsername, seedAdmin, type SeedAdminResult } from '../services/seed-admin.js';

/**
 * The team accounts (`npm run seed:dev`).
 *
 * These are the real people who use this deployment, not placeholders, so the
 * script is idempotent and non-destructive: an address that already exists is
 * left completely alone, password included. Re-running it against a live
 * database must never reset somebody's password.
 *
 * One address is one person. `aniket@remostarts.com` was listed three times
 * (senior-manager, superadmin, admin) but `email` is unique in the user model
 * and `role` is a single value, so one listing has to win: senior-manager.
 *
 * The roles are the built-in ladder from `@/shared` and nothing else -
 * there is no custom-role document anywhere in this seed. A requested role that
 * the ladder does not name is mapped to the rung that grants it the right
 * permissions:
 *
 *   senior-manager    -> management  (adds user:write, projects:write, pricing:write)
 *   figma-developer   -> developer
 *   technical-support -> developer
 *   superadmin        -> dropped, it names the same person as senior-manager
 *   admin             -> dropped for the same reason; `admin@remostarts.com` is
 *                        the administrator, and `admin` is not on the ladder at
 *                        all - it holds the explicit union of every permission.
 *
 * It refuses to run in production. Real users' passwords in a production
 * database is a back door, and "it was only run once" is not a defence.
 */

/** Every account below signs in with this, and changes it from the profile page. */
export const TEAM_PASSWORD = 'password@123';

interface TeamAccount {
  email: string;
  username: string;
  role: Role;
  fullName: string;
  department: string;
  /** `client` for the two external addresses; staff otherwise. */
  kind?: 'staff' | 'client';
  /** The client organisation, for external addresses only. */
  clientId?: string;
}

export const TEAM_ACCOUNTS: ReadonlyArray<TeamAccount> = [
  {
    email: 'ubio@remostarts.com',
    username: 'ubio',
    role: 'ceo',
    fullName: 'Ubio',
    department: 'Executive',
  },
  {
    email: 'yash@remostarts.com',
    username: 'yash',
    role: 'cto',
    fullName: 'Yash',
    department: 'Executive',
  },
  {
    email: 'aminul@remostarts.com',
    username: 'aminul',
    role: 'manager',
    fullName: 'Aminul',
    department: 'Delivery',
  },
  {
    // senior-manager. Not an administrator: that is `admin@remostarts.com`.
    email: 'aniket@remostarts.com',
    username: 'aniket',
    role: 'management',
    fullName: 'Aniket',
    department: 'Delivery',
  },
  {
    // The administrator, and the only account holding `admin`. It sits outside
    // the ladder and carries the explicit union of every permission key, which
    // is what makes the administrator area and role assignment reachable.
    email: 'admin@remostarts.com',
    username: 'admin',
    role: 'admin',
    fullName: 'Remostarts Admin',
    department: 'IT',
  },
  {
    email: 'jillur@remostarts.com',
    username: 'jillur',
    role: 'developer',
    fullName: 'Jillur',
    department: 'Engineering',
  },
  {
    email: 'anurag@remostarts.com',
    username: 'anurag',
    role: 'developer',
    fullName: 'Anurag',
    department: 'Engineering',
  },
  {
    email: 'jahir@remostarts.com',
    username: 'jahir',
    role: 'developer',
    fullName: 'Jahir',
    department: 'Engineering',
  },
  {
    email: 'norah@remostarts.com',
    username: 'norah',
    role: 'developer',
    fullName: 'Norah',
    department: 'Design',
  },
  {
    email: 'lyn@remostarts.com',
    username: 'lyn',
    role: 'developer',
    fullName: 'Lyn',
    department: 'Support',
  },
  {
    // label: client-rootremit
    email: 'esame@rootremit.com',
    username: 'esame',
    role: 'client',
    kind: 'client',
    clientId: 'RootRemit',
    fullName: 'Esame',
    department: 'RootRemit',
  },
  {
    // label: client-vybe-bank
    email: 'gabriel@vybebank.com',
    username: 'gabriel',
    role: 'client',
    kind: 'client',
    clientId: 'Vybe Bank',
    fullName: 'Gabriel',
    department: 'Vybe Bank',
  },
  {
    // label: client-vybe-bank
    email: 'esame@vybebank.com',
    username: 'esame_vybe',
    role: 'client',
    kind: 'client',
    clientId: 'Vybe Bank',
    fullName: 'Esame',
    department: 'Vybe Bank',
  },
  {
    // label: client-vybe-bank
    email: 'ayeni@vybebank.com',
    username: 'ayeni',
    role: 'client',
    kind: 'client',
    clientId: 'Vybe Bank',
    fullName: 'Ayeni',
    department: 'Vybe Bank',
  },
  {
    email: 'daniel@remostarts.com',
    username: 'daniel',
    role: 'management',
    fullName: 'Daniel',
    department: 'Chief Operating Officer',
  },
  {
    email: 'blessing@remostarts.com',
    username: 'blessing',
    role: 'management',
    fullName: 'Blessing',
    department: 'Chief Marketing Officer',
  },
  {
    email: 'ese@remostarts.com',
    username: 'ese',
    role: 'manager',
    fullName: 'Ese',
    department: 'Head of Marketing',
  },
  {
    email: 'chidinma@remostarts.com',
    username: 'chidinma',
    role: 'developer',
    fullName: 'Chidinma',
    department: 'Social Media Manager',
  },
  {
    email: 'ebube@remostarts.com',
    username: 'ebube',
    role: 'developer',
    fullName: 'Ebube',
    department: 'Technical Support',
  },
  {
    email: 'ijeoma@remostarts.com',
    username: 'ijeoma',
    role: 'manager',
    fullName: 'Ijeoma',
    department: 'Head of Operations',
  },
  {
    email: 'victor@remostarts.com',
    username: 'victor',
    role: 'developer',
    fullName: 'Victor',
    department: 'Facility Manager',
  },
];

/**
 * The accounts earlier seeds left behind, and the demo client a manual test
 * created. Removed on every run of this script so the directory holds the team
 * and nothing else.
 *
 * `SEED_ADMIN_EMAIL` is in this list, so point it at a real address in `.env`
 * after running this - `seedAdmin()` runs on every boot and would otherwise
 * recreate the placeholder administrator the moment the API restarts.
 */
export const LEGACY_SEED_EMAILS: readonly string[] = [
  'admin@claimdesk.local',
  'developer@claimdesk.local',
  'manager@claimdesk.local',
  'locked@claimdesk.local',
  'aniket@client.com',
];

/** Throws rather than exit, so a test can assert the refusal without a subprocess. */
export function assertNotProduction(nodeEnv: string = env.NODE_ENV): void {
  if (nodeEnv === 'production') {
    throw new Error('seed:dev refuses to run with NODE_ENV=production');
  }
}

export interface RemoveLegacyResult {
  removed: string[];
  sessionsRemoved: number;
}

/**
 * The two client projects, one per external organisation.
 *
 * `clientName` has to match the `clientId` on the client accounts above: that
 * string is the join between a person and the project they may see, and the
 * tenant boundary in `services/project-scope.ts` reads `projectIds`, not this.
 */
export const TEAM_PROJECTS: ReadonlyArray<{ name: string; slug: string; clientName: string; description: string }> = [
  {
    name: 'Vybe Bank',
    slug: 'vybe-bank',
    clientName: 'Vybe Bank',
    description: 'Vybe Bank — banking platform support and delivery.',
  },
  {
    name: 'RootRemit',
    slug: 'rootremit',
    clientName: 'RootRemit',
    description: 'RootRemit — remittance platform support and delivery.',
  },
];

export interface SeedProjectsResult {
  created: string[];
  skipped: string[];
  linked: string[];
}

/**
 * Creates the projects and gives each client account sight of its own.
 *
 * Idempotent by slug. The linking matters more than the creation: a client
 * account with an empty `projectIds` sees an empty board, because
 * `assertProjectAccess` refuses every project it was not explicitly given.
 */
export async function seedProjects(): Promise<SeedProjectsResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const linked: string[] = [];

  for (const definition of TEAM_PROJECTS) {
    let project = await Project.findOne({ slug: definition.slug }).exec();
    if (project) {
      skipped.push(definition.slug);
    } else {
      // Through the service so the project.created audit row is written the
      // same way the API writes it. A slug race lands here as a throw.
      const summary = await createProject(null, definition);
      project = await Project.findById(summary.id).exec();
      created.push(definition.slug);
    }
    if (!project) continue;

    const clients = await User.find({ clientId: definition.clientName }).exec();
    for (const client of clients) {
      const alreadyMember = project.members.some((member) => member.equals(client._id));
      if (!alreadyMember) {
        project.members.push(client._id);
      }

      const alreadyScoped = (client.projectIds ?? []).some((id) => id.equals(project._id));
      if (!alreadyScoped) {
        client.projectIds.push(project._id);
        await client.save();
        linked.push(`${client.email} -> ${definition.slug}`);
      }
    }
    await project.save();
  }

  return { created, skipped, linked };
}

/**
 * Deletes the legacy accounts and their sessions.
 *
 * Sessions go too: a session document outlives the user it points at, and a
 * stale cookie resolving to a deleted account should be a clean sign-out rather
 * than a request that fails somewhere deeper.
 */
export async function removeLegacyAccounts(): Promise<RemoveLegacyResult> {
  const victims = await User.find({ email: { $in: LEGACY_SEED_EMAILS } }, { _id: 1, email: 1 }).exec();
  if (victims.length === 0) {
    return { removed: [], sessionsRemoved: 0 };
  }

  const ids = victims.map((user) => user._id);
  const sessions = await Session.deleteMany({ user: { $in: ids } }).exec();
  await User.deleteMany({ _id: { $in: ids } }).exec();

  return { removed: victims.map((user) => user.email), sessionsRemoved: sessions.deletedCount ?? 0 };
}

export interface SeedDevResult {
  created: string[];
  skipped: string[];
  admin: SeedAdminResult;
}

export async function seedDevelopmentAccounts(): Promise<SeedDevResult> {
  assertNotProduction();

  const created: string[] = [];
  const skipped: string[] = [];

  for (const account of TEAM_ACCOUNTS) {
    const existing = await User.exists({ email: account.email });
    if (existing) {
      // Non-destructive, like the administrator seed: a password somebody chose
      // during manual testing is not reset behind their back.
      skipped.push(account.email);
      logger.info({ email: account.email }, 'team account skipped: it already exists');
      continue;
    }

    const username = (await User.exists({ username: account.username }))
      ? `${deriveUsername(account.email)}-dev`
      : account.username;

    await User.create({
      email: account.email,
      username,
      passwordHash: await hashPassword(TEAM_PASSWORD),
      role: account.role,
      kind: account.kind ?? 'staff',
      clientId: account.clientId ?? null,
      active: true,
      mustChangePassword: false,
      profile: { fullName: account.fullName, department: account.department },
    });
    created.push(`${account.email} (${account.role})`);
  }

  // Deliberately after the loop. `seedAdmin()` creates whatever
  // `SEED_ADMIN_EMAIL` names with the bootstrap password and
  // `mustChangePassword`, so running it first would seize an address the team
  // list owns (`aniket@remostarts.com`) and hand it the wrong role and the wrong
  // password, which the loop would then skip as "already exists".
  const admin = await seedAdmin();

  return { created, skipped, admin };
}

async function main(): Promise<void> {
  try {
    assertNotProduction();
  } catch (error) {
    logger.fatal({ err: error }, 'refusing to seed team accounts');
    process.exitCode = 1;
    return;
  }

  await connectDatabase(env.MONGODB_URI);
  const removed = await removeLegacyAccounts();
  const result = await seedDevelopmentAccounts();
  // After the accounts: linking a client to its project needs both to exist.
  const projects = await seedProjects();
  await disconnect();

  logger.info(
    {
      removed: removed.removed,
      sessionsRemoved: removed.sessionsRemoved,
      created: result.created,
      skipped: result.skipped,
      adminCreated: result.admin.created,
      projectsCreated: projects.created,
      projectsSkipped: projects.skipped,
      linked: projects.linked,
    },
    'team seed finished',
  );
  // Credentials are printed on purpose, and only ever here.
  process.stdout.write(
    [
      '',
      `Removed ${removed.removed.length} legacy account(s): ${removed.removed.join(', ') || 'none'}`,
      '',
      'Team accounts (development database only):',
      ...TEAM_ACCOUNTS.map(
        (account) =>
          `  ${(account.clientId ?? account.role).padEnd(14)} ${account.email} / ${TEAM_PASSWORD}`,
      ),
      '',
      `Projects: ${TEAM_PROJECTS.map((project) => `${project.name} (${project.slug})`).join(', ')}`,
      '',
    ].join('\n'),
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void main().catch((error: unknown) => {
    logger.fatal({ err: error }, 'team seed failed');
    process.exitCode = 1;
  });
}
