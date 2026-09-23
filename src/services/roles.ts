import { Types } from 'mongoose';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  ROLE_LABELS,
  ROLES,
  isRole,
  permissionsForRole,
  resolveCustomRolePermissions,
  type CreateCustomRoleInput,
  type CustomRoleDTO,
  type Permission,
  type Role,
  type UpdateCustomRoleInput,
} from '@/shared';
import { CustomRole, type CustomRoleDocument } from '../models/custom-role.js';
import { User } from '../models/user.js';
import { AppError } from '../middleware/error-handler.js';
import { writeAudit } from './audit.js';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Resolves the full array of permissions for a user, whether standard or custom.
 */
export async function resolveUserPermissions(user: {
  role: string;
  customRoleId?: Types.ObjectId | string | null;
} | null | undefined): Promise<readonly Permission[]> {
  if (!user) return [];

  if (user.role === 'admin') {
    return ALL_PERMISSIONS;
  }

  if (user.customRoleId) {
    const customRole = await CustomRole.findById(user.customRoleId).lean();
    if (customRole) {
      return resolveCustomRolePermissions(
        customRole.baseRole as Role | null | undefined,
        customRole.permissions as readonly Permission[],
      );
    }
  }

  // Fallback: check if role name or slug matches a custom role
  if (!isRole(user.role)) {
    const customRole = await CustomRole.findOne({
      $or: [{ slug: user.role.toLowerCase() }, { name: user.role }],
    }).lean();
    if (customRole) {
      return resolveCustomRolePermissions(
        customRole.baseRole as Role | null | undefined,
        customRole.permissions as readonly Permission[],
      );
    }
    return [];
  }

  return permissionsForRole(user.role as Role);
}

export async function listRolesWithMetrics() {
  const [userRoleCounts, customRoleUserCounts, customRoles] = await Promise.all([
    User.aggregate<{ _id: string; count: number }>([
      { $match: { active: true } },
      { $group: { _id: '$role', count: { $sum: 1 } } },
    ]),
    User.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { active: true, customRoleId: { $ne: null } } },
      { $group: { _id: '$customRoleId', count: { $sum: 1 } } },
    ]),
    CustomRole.find().sort({ createdAt: -1 }).populate('createdBy', 'profile.fullName email username').lean(),
  ]);

  const standardCountsMap = new Map<string, number>();
  for (const item of userRoleCounts) {
    standardCountsMap.set(item._id, item.count);
  }

  const customCountsMap = new Map<string, number>();
  for (const item of customRoleUserCounts) {
    customCountsMap.set(String(item._id), item.count);
  }

  const standardRoles = ROLES.map((role) => ({
    id: role,
    name: ROLE_LABELS[role] ?? role,
    roleKey: role,
    type: 'standard' as const,
    description: `Standard built-in system role for ${ROLE_LABELS[role]}.`,
    permissions: permissionsForRole(role),
    userCount: standardCountsMap.get(role) ?? 0,
  }));

  const formattedCustomRoles: CustomRoleDTO[] = customRoles.map((role) => {
    const creator = role.createdBy as any;
    return {
      id: role._id.toString(),
      name: role.name,
      slug: role.slug,
      description: role.description || '',
      baseRole: role.baseRole,
      permissions: (role.permissions || []) as Permission[],
      userCount: customCountsMap.get(role._id.toString()) ?? 0,
      createdAt: (role as any).createdAt ? (role as any).createdAt.toISOString() : new Date().toISOString(),
      updatedAt: (role as any).updatedAt ? (role as any).updatedAt.toISOString() : new Date().toISOString(),
      createdBy: creator
        ? {
            id: creator._id ? creator._id.toString() : String(creator),
            fullName: creator.profile?.fullName || creator.username || 'Admin',
            email: creator.email || '',
          }
        : null,
    };
  });

  return {
    standard: standardRoles,
    custom: formattedCustomRoles,
  };
}

export async function createCustomRole(
  input: CreateCustomRoleInput,
  authorId: string,
): Promise<CustomRoleDocument> {
  const slug = slugify(input.name);

  // Validate that name and slug are not standard role names
  if (ROLES.includes(slug as Role) || ROLES.includes(input.name.toLowerCase() as Role)) {
    throw new AppError('VALIDATION_FAILED', `Cannot use '${input.name}' because it conflicts with a standard role name.`);
  }

  const existing = await CustomRole.findOne({
    $or: [{ name: { $regex: new RegExp(`^${input.name.trim()}$`, 'i') } }, { slug }],
  }).lean();

  if (existing) {
    throw new AppError('VALIDATION_FAILED', `A role named '${input.name}' already exists.`);
  }

  // Ensure all permissions are valid
  const cleanPermissions = input.permissions.filter((p) => PERMISSIONS.includes(p));
  if (cleanPermissions.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Role must include at least one valid permission.');
  }

  const customRole = await CustomRole.create({
    name: input.name.trim(),
    slug,
    description: input.description?.trim() || '',
    baseRole: input.baseRole || null,
    permissions: cleanPermissions,
    createdBy: Types.ObjectId.isValid(authorId) ? new Types.ObjectId(authorId) : null,
  });

  await writeAudit({
    userId: authorId,
    action: 'role.created',
    resourceType: 'custom_role',
    resourceId: customRole.id,
    details: {
      name: customRole.name,
      slug: customRole.slug,
      permissionsCount: cleanPermissions.length,
      baseRole: customRole.baseRole,
    },
  });

  return customRole;
}

export async function getCustomRoleById(id: string): Promise<CustomRoleDocument> {
  if (!Types.ObjectId.isValid(id)) {
    throw new AppError('NOT_FOUND', 'Custom role not found.');
  }
  const role = await CustomRole.findById(id).populate('createdBy', 'profile.fullName email username');
  if (!role) {
    throw new AppError('NOT_FOUND', 'Custom role not found.');
  }
  return role;
}

export async function updateCustomRole(
  id: string,
  input: UpdateCustomRoleInput,
  authorId: string,
): Promise<CustomRoleDocument> {
  const role = await getCustomRoleById(id);

  if (input.name && input.name.trim() !== role.name) {
    const newSlug = slugify(input.name);
    if (ROLES.includes(newSlug as Role) || ROLES.includes(input.name.toLowerCase() as Role)) {
      throw new AppError('VALIDATION_FAILED', `Cannot use '${input.name}' because it conflicts with a standard role name.`);
    }
    const conflict = await CustomRole.findOne({
      _id: { $ne: role._id },
      $or: [{ name: { $regex: new RegExp(`^${input.name.trim()}$`, 'i') } }, { slug: newSlug }],
    }).lean();
    if (conflict) {
      throw new AppError('VALIDATION_FAILED', `A role named '${input.name}' already exists.`);
    }
    role.name = input.name.trim();
    role.slug = newSlug;
  }

  if (typeof input.description === 'string') {
    role.description = input.description.trim();
  }

  if (input.permissions && input.permissions.length > 0) {
    const cleanPermissions = input.permissions.filter((p) => PERMISSIONS.includes(p));
    if (cleanPermissions.length === 0) {
      throw new AppError('VALIDATION_FAILED', 'Role must include at least one valid permission.');
    }
    role.permissions = cleanPermissions as any;
  }

  await role.save();

  await writeAudit({
    userId: authorId,
    action: 'role.updated',
    resourceType: 'custom_role',
    resourceId: role.id,
    details: {
      name: role.name,
      slug: role.slug,
      permissionsCount: role.permissions.length,
    },
  });

  return role;
}

export async function deleteCustomRole(id: string, authorId: string): Promise<void> {
  const role = await getCustomRoleById(id);

  // Check if any users currently have this custom role
  const userCount = await User.countDocuments({
    $or: [{ customRoleId: role._id }, { role: role.slug }, { role: role.name }],
  });

  if (userCount > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Cannot delete role '${role.name}' because ${userCount} user(s) are currently assigned to it. Please reassign them before deleting.`,
    );
  }

  await CustomRole.findByIdAndDelete(role._id);

  await writeAudit({
    userId: authorId,
    action: 'role.deleted',
    resourceType: 'custom_role',
    resourceId: role.id,
    details: {
      name: role.name,
      slug: role.slug,
    },
  });
}

export async function bulkAssignRoles(
  actorId: string | Types.ObjectId | null,
  userIds: string[],
  roleOrCustomId: string,
  customRoleId?: string | null,
): Promise<{ modifiedCount: number }> {
  let role = roleOrCustomId;
  let targetCustomRoleId: Types.ObjectId | null = null;

  if (customRoleId && Types.ObjectId.isValid(customRoleId)) {
    const custom = await CustomRole.findById(customRoleId).lean();
    if (custom) {
      role = custom.slug;
      targetCustomRoleId = custom._id;
    }
  } else if (!isRole(roleOrCustomId)) {
    if (Types.ObjectId.isValid(roleOrCustomId)) {
      const custom = await CustomRole.findById(roleOrCustomId).lean();
      if (custom) {
        role = custom.slug;
        targetCustomRoleId = custom._id;
      }
    } else {
      const custom = await CustomRole.findOne({
        $or: [{ slug: roleOrCustomId.toLowerCase() }, { name: roleOrCustomId }],
      }).lean();
      if (custom) {
        role = custom.slug;
        targetCustomRoleId = custom._id;
      }
    }
  }

  const result = await User.updateMany(
    { _id: { $in: userIds.map((id) => new Types.ObjectId(id)) } },
    { $set: { role, customRoleId: targetCustomRoleId } },
  );

  await writeAudit({
    userId: actorId,
    action: 'user.bulk_role_reassigned',
    resourceType: 'user',
    details: {
      userIds,
      role,
      customRoleId: targetCustomRoleId ? targetCustomRoleId.toString() : null,
      modifiedCount: result.modifiedCount,
    },
  });

  return { modifiedCount: result.modifiedCount };
}

