import { Types } from 'mongoose';
import { User } from '../models/user.js';
import { serializeUserSummary, type UserSummaryItem } from './user-directory.js';
import { writeAudit } from './audit.js';
import { hashPassword, verifyPassword } from './password.js';
import { resolveUserPermissions } from './roles.js';
import type { Permission, ProfileUpdateInput } from '@/shared';

export interface UserProfileResponse extends UserSummaryItem {
  bio: string;
  assignedProjectsCount: number;
  ticketsRaisedCount: number;
  ticketsResolvedCount: number;
  permissions: readonly Permission[];
}

export async function getUserProfile(idOrUsername: string): Promise<UserProfileResponse> {
  const query = Types.ObjectId.isValid(idOrUsername)
    ? { $or: [{ _id: new Types.ObjectId(idOrUsername) }, { username: idOrUsername }] }
    : { username: idOrUsername };

  const user = await User.findOne(query).exec();
  if (!user) {
    throw new Error('User not found');
  }

  const summary = serializeUserSummary(user);
  const permissions = await resolveUserPermissions(user);

  return {
    ...summary,
    bio: user.profile?.bio ?? '',
    assignedProjectsCount: 0,
    ticketsRaisedCount: 0,
    ticketsResolvedCount: 0,
    permissions,
  };
}

export async function updateSelfProfile(
  userId: string | Types.ObjectId,
  input: ProfileUpdateInput,
): Promise<UserProfileResponse> {
  const user = await User.findById(userId).exec();
  if (!user) {
    throw new Error('User not found');
  }

  if (input.fullName !== undefined) {
    user.profile.fullName = input.fullName;
  }
  if (input.phone !== undefined) {
    user.profile.phone = input.phone;
  }
  if (input.bio !== undefined) {
    user.profile.bio = input.bio;
  }
  if (input.pictureUrl !== undefined) {
    user.profile.pictureUrl = input.pictureUrl;
  }

  await user.save();

  await writeAudit({
    userId,
    action: 'profile.updated',
    resourceType: 'user',
    resourceId: user._id.toHexString(),
    details: {
      fullName: user.profile?.fullName,
      phone: user.profile?.phone,
      hasBio: Boolean(user.profile?.bio),
      hasPicture: Boolean(user.profile?.pictureUrl),
    },
  });

  return getUserProfile(user._id.toHexString());
}

export async function changeUserPassword(
  userId: string | Types.ObjectId,
  input: { currentPassword: string; newPassword: string },
): Promise<{ success: true }> {
  const user = await User.findById(userId).select('+passwordHash').exec();
  if (!user) {
    throw new Error('User not found');
  }

  // If user has a password set, verify current password
  if (user.passwordHash) {
    const valid = await verifyPassword(input.currentPassword, user.passwordHash);
    if (!valid) {
      throw new Error('Current password is incorrect.');
    }
  }

  user.passwordHash = await hashPassword(input.newPassword);
  user.mustChangePassword = false;
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  await user.save();

  await writeAudit({
    userId,
    action: 'auth.password_changed',
    resourceType: 'user',
    resourceId: user._id.toHexString(),
    details: { method: 'profile' },
  });

  return { success: true };
}
