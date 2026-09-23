import { Types } from 'mongoose';
import { isRole } from '@/shared';
import { User } from '../models/user.js';
import { CustomRole } from '../models/custom-role.js';
import { hashPassword } from './password.js';
import { writeAudit } from './audit.js';
import { serializeUserSummary, type UserSummaryItem } from './user-directory.js';
import type { CreateUserInput, UpdateUserInput } from '@/shared';

async function resolveRoleAndCustomId(roleInput?: string, customRoleIdInput?: string | null) {
  let role = roleInput || 'developer';
  let customRoleId: Types.ObjectId | null = null;

  if (customRoleIdInput && Types.ObjectId.isValid(customRoleIdInput)) {
    const custom = await CustomRole.findById(customRoleIdInput);
    if (custom) {
      role = custom.slug;
      customRoleId = custom._id;
    }
  } else if (!isRole(role)) {
    if (Types.ObjectId.isValid(role)) {
      const custom = await CustomRole.findById(role);
      if (custom) {
        role = custom.slug;
        customRoleId = custom._id;
      }
    } else {
      const custom = await CustomRole.findOne({
        $or: [{ slug: role.toLowerCase() }, { name: role }],
      });
      if (custom) {
        role = custom.slug;
        customRoleId = custom._id;
      }
    }
  }

  return { role, customRoleId };
}

export async function createUser(
  actorId: string | Types.ObjectId | null,
  input: CreateUserInput,
): Promise<UserSummaryItem> {
  const existingEmail = await User.findOne({ email: input.email }).lean().exec();
  if (existingEmail) {
    const error: any = new Error('An account with this email address already exists');
    error.statusCode = 409;
    error.httpStatus = 409;
    throw error;
  }

  const existingUsername = await User.findOne({ username: input.username }).lean().exec();
  if (existingUsername) {
    const error: any = new Error('This username is already taken');
    error.statusCode = 409;
    error.httpStatus = 409;
    throw error;
  }

  const passwordHash = await hashPassword(input.password);
  const { role, customRoleId } = await resolveRoleAndCustomId(input.role, input.customRoleId);

  let user;
  try {
    user = await User.create({
      email: input.email,
      username: input.username,
      passwordHash,
      role,
      customRoleId,
      active: true,
      profile: {
        fullName: input.fullName,
        department: input.department ?? '',
        phone: input.phone ?? '',
        bio: '',
        pictureUrl: null,
      },
    });
  } catch (err: any) {
    if (err?.code === 11000) {
      const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || 'email';
      const error: any = new Error(`An account with this ${field} already exists`);
      error.statusCode = 409;
      error.httpStatus = 409;
      throw error;
    }
    throw err;
  }

  await writeAudit({
    userId: actorId,
    action: 'user.created',
    resourceType: 'user',
    resourceId: user._id.toHexString(),
    details: {
      email: user.email,
      username: user.username,
      role: user.role,
      customRoleId: user.customRoleId?.toString() ?? null,
    },
  });

  return serializeUserSummary(user);
}

export async function updateUser(
  actorId: string | Types.ObjectId | null,
  userId: string | Types.ObjectId,
  input: UpdateUserInput,
): Promise<UserSummaryItem> {
  const user = await User.findById(userId).exec();
  if (!user) {
    throw new Error('User not found');
  }

  // Deactivation safety check: Cannot deactivate the last active administrator
  if (input.active === false && user.role === 'admin' && user.active) {
    const activeAdminCount = await User.countDocuments({ role: 'admin', active: true }).exec();
    if (activeAdminCount <= 1) {
      throw new Error('Cannot deactivate the last active administrator');
    }
  }

  const previousState = {
    role: user.role,
    customRoleId: user.customRoleId ? user.customRoleId.toString() : null,
    active: user.active,
    department: user.profile?.department,
    fullName: user.profile?.fullName,
  };

  if (typeof input.active === 'boolean') {
    user.active = input.active;
  }
  if (input.role !== undefined || input.customRoleId !== undefined) {
    const { role, customRoleId } = await resolveRoleAndCustomId(
      input.role ?? user.role,
      input.customRoleId !== undefined ? input.customRoleId : user.customRoleId?.toString(),
    );
    user.role = role;
    user.customRoleId = customRoleId;
  }
  if (input.fullName !== undefined) {
    user.profile.fullName = input.fullName;
  }
  if (input.department !== undefined) {
    user.profile.department = input.department;
  }
  if (input.phone !== undefined) {
    user.profile.phone = input.phone;
  }

  await user.save();

  await writeAudit({
    userId: actorId,
    action: 'user.updated',
    resourceType: 'user',
    resourceId: user._id.toHexString(),
    details: {
      from: previousState,
      to: {
        role: user.role,
        active: user.active,
        department: user.profile?.department,
        fullName: user.profile?.fullName,
      },
    },
  });

  return serializeUserSummary(user);
}
