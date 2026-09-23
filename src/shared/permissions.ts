/**
 * Claim Desk roles and permissions.
 *
 * One ladder, one vocabulary. The API enforces these keys in server-side
 * middleware and the web shell filters its navigation by the same keys, so a
 * menu entry and the route behind it cannot disagree.
 *
 * Decision D004: the built-in ladder (developer, manager, management, CEO, CTO,
 * each inheriting the one below) is enforced server-side using named permission
 * keys. `admin` is not part of the ladder - it holds the explicit union of every
 * key, and the configurable tick-box matrix that will live beside it arrives with
 * the Command Centre milestone.
 */

/** Every role a user document may carry. */
export const ROLES = ['admin', 'developer', 'manager', 'management', 'ceo', 'cto', 'client'] as const;

export type Role = (typeof ROLES)[number];

/**
 * The inheritance ladder, weakest first. Each role inherits every permission
 * held by the role before it.
 */
export const ROLE_LADDER = ['developer', 'manager', 'management', 'ceo', 'cto'] as const;

export type LadderRole = (typeof ROLE_LADDER)[number];

/** Named permission keys. These strings are the contract between web and API. */
export const PERMISSIONS = [
  'profile:read',
  'profile:write:self',
  'org:read',
  'user:read',
  'user:write',
  'role:assign',
  'audit:read',
  'admin:access',
  'projects:read',
  'projects:write',
  'tickets:read',
  'tickets:create',
  'tickets:claim',
  'tickets:assign',
  'tickets:resolve',
  'tickets:close',
  'escalation:read',
  'escalation:write',
  'tasks:read',
  'tasks:write',
  'services:read',
  'services:write',
  'dashboard:read',
  'dashboard:export',
  'events:read',
  'events:write',
  'pricing:read',
  'pricing:write',
  'prd:write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * What each ladder role adds on top of the role below it. The map is deliberately
 * additive: `permissionsForRole` walks the ladder rather than restating every key
 * per role, so adding a role cannot leave a silent gap in coverage.
 */
export const ROLE_PERMISSION_ADDITIONS: Record<LadderRole, readonly Permission[]> = {
  developer: [
    'profile:read',
    'profile:write:self',
    'org:read',
    'user:read',
    'projects:read',
    'tickets:read',
    'tickets:create',
    'tickets:claim',
    'tickets:resolve',
    'tasks:read',
    'tasks:write',
    'prd:write',
    'services:read',
    'dashboard:read',
    'events:read',
    'events:write',
    'pricing:read',
  ],
  manager: ['audit:read', 'tickets:assign', 'escalation:read', 'escalation:write', 'services:write', 'dashboard:export'],
  management: ['user:write', 'projects:write', 'pricing:write'],
  ceo: ['role:assign'],
  cto: ['admin:access'],
};

/** Every permission key, in canonical order. `admin` holds exactly this set. */
export const ALL_PERMISSIONS: readonly Permission[] = PERMISSIONS;

const PERMISSION_SET = new Set<string>(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

function isLadderRole(role: Role): role is LadderRole {
  return (ROLE_LADDER as readonly string[]).includes(role);
}

/**
 * The effective permission list for a role.
 *
 * Derived from the ladder, never hand-listed: `cto` inherits `ceo` inherits
 * `management` inherits `manager` inherits `developer`. `admin` short-circuits to
 * the union of every key. The result is returned in the canonical `PERMISSIONS`
 * order so callers can compare lists without sorting.
 */
export function permissionsForRole(role: Role): readonly Permission[] {
  if (role === 'admin') {
    return ALL_PERMISSIONS;
  }
  if (role === 'client') {
    return [
      'profile:read',
      'profile:write:self',
      'projects:read',
      'tasks:read',
      'tickets:read',
      'tickets:create',
      'tickets:close',
      'services:read',
      'dashboard:read',
      'events:read',
      'pricing:read',
    ];
  }
  if (!isLadderRole(role)) {
    return [];
  }

  const collected = new Set<Permission>();
  const stopAt = ROLE_LADDER.indexOf(role);
  for (let index = 0; index <= stopAt; index += 1) {
    const ladderRole = ROLE_LADDER[index];
    if (ladderRole === undefined) {
      continue;
    }
    for (const permission of ROLE_PERMISSION_ADDITIONS[ladderRole]) {
      collected.add(permission);
    }
  }

  return PERMISSIONS.filter((permission) => collected.has(permission));
}

/** True when the role holds the key directly or through the ladder. */
export function roleHasPermission(role: Role, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

/**
 * True when `role` sits at or above `target` on the ladder, so it inherits the
 * target role's capabilities. `admin` stands outside the ladder and inherits
 * nothing implicitly - it holds every key instead.
 */
export function inheritsRole(role: Role, target: LadderRole): boolean {
  if (role === 'admin') {
    return false;
  }
  if (!isLadderRole(role)) {
    return false;
  }
  return ROLE_LADDER.indexOf(role) >= ROLE_LADDER.indexOf(target);
}

/** Human-readable role labels for the interface. */
export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  developer: 'Developer',
  manager: 'Manager',
  management: 'Management',
  ceo: 'Chief Executive Officer',
  cto: 'Chief Technology Officer',
  client: 'Client',
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  'profile:read': 'View profiles',
  'profile:write:self': 'Edit own profile',
  'org:read': 'View the organization chart',
  'user:read': 'View the user directory',
  'user:write': 'Edit users',
  'role:assign': 'Assign roles',
  'audit:read': 'Read the audit trail',
  'admin:access': 'Open the administrator area',
  'projects:read': 'View assigned projects',
  'projects:write': 'Manage projects and clients',
  'tickets:read': 'View tickets',
  'tickets:create': 'Submit new tickets',
  'tickets:claim': 'Claim unassigned tickets',
  'tickets:assign': 'Assign tickets to team members',
  'tickets:resolve': 'Resolve tickets',
  'tickets:close': 'Close and rate tickets',
  'escalation:read': 'View escalation rules and matrix',
  'escalation:write': 'Configure escalation thresholds',
  'tasks:read': 'View project Kanban and Watchtower',
  'tasks:write': 'Manage task cards, boards and subtasks',
  'services:read': 'View service health and incidents',
  'services:write': 'Configure and check services',
  'dashboard:read': 'View unified project dashboards',
  'dashboard:export': 'Export dashboard analytics',
  'events:read': 'View dated events and renewals',
  'events:write': 'Manage and renew events',
  'pricing:read': 'View feature pricing models',
  'pricing:write': 'Manage feature pricing records',
  'prd:write': 'Use AI PRD Breakdown to generate project milestones and tasks',
};

export const PERMISSION_MODULE_GROUPS = [
  {
    id: 'tickets',
    label: 'Tickets & Support Desk',
    description: 'Ticket submission, claiming, assignment, status progression, and closure',
    permissions: [
      'tickets:read',
      'tickets:create',
      'tickets:claim',
      'tickets:assign',
      'tickets:resolve',
      'tickets:close',
    ],
  },
  {
    id: 'projects',
    label: 'Projects & Workspaces',
    description: 'Project scopes, client associations, and workspace access',
    permissions: ['projects:read', 'projects:write'],
  },
  {
    id: 'tasks',
    label: 'Kanban, PRD Breakdown & Watchtower',
    description: 'Task boards, swimlanes, AI PRD breakdown, and progress tracking',
    permissions: ['tasks:read', 'tasks:write', 'prd:write'],
  },
  {
    id: 'escalation',
    label: 'Escalation Automation',
    description: 'Escalation rules, thresholds, and breach matrix management',
    permissions: ['escalation:read', 'escalation:write'],
  },
  {
    id: 'services',
    label: 'Service Health & Monitoring',
    description: 'Service status, health tracking, and incident logging',
    permissions: ['services:read', 'services:write'],
  },
  {
    id: 'dashboard',
    label: 'Dashboards & Analytics',
    description: 'Unified project metrics, CSAT scores, and data exports',
    permissions: ['dashboard:read', 'dashboard:export'],
  },
  {
    id: 'events',
    label: 'Events & Renewals',
    description: 'Calendar events, domain/contract renewals, and notifications',
    permissions: ['events:read', 'events:write'],
  },
  {
    id: 'pricing',
    label: 'Feature Pricing & Scope',
    description: 'Feature-level cost and estimate calculator',
    permissions: ['pricing:read', 'pricing:write'],
  },
  {
    id: 'users',
    label: 'Users & Roles',
    description: 'User directory, user account management, and role assignment',
    permissions: ['user:read', 'user:write', 'role:assign'],
  },
  {
    id: 'admin',
    label: 'Administration & System',
    description: 'Audit logs, system settings, profiles, and organization hierarchy',
    permissions: ['admin:access', 'audit:read', 'org:read', 'profile:read', 'profile:write:self'],
  },
] as const;

/**
 * Resolves the effective permission array for a custom role definition.
 * Inherits base role permissions (if specified) plus explicitly granted permissions.
 */
export function resolveCustomRolePermissions(
  baseRole: Role | null | undefined,
  grantedPermissions: readonly Permission[],
  deniedPermissions?: readonly Permission[],
): readonly Permission[] {
  const set = new Set<Permission>();
  if (baseRole) {
    for (const p of permissionsForRole(baseRole)) {
      set.add(p);
    }
  }
  for (const p of grantedPermissions) {
    if (isPermission(p)) {
      set.add(p);
    }
  }
  if (deniedPermissions) {
    for (const p of deniedPermissions) {
      set.delete(p);
    }
  }
  return PERMISSIONS.filter((p) => set.has(p));
}

