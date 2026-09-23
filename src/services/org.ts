import { Types } from 'mongoose';
import { User } from '../models/user.js';
import { writeAudit } from './audit.js';
import { serializeUserSummary, type UserSummaryItem } from './user-directory.js';

export interface OrgTreeNode extends UserSummaryItem {
  directReports: OrgTreeNode[];
}

export interface OrgChartResponse {
  tree: OrgTreeNode[];
  unassigned: UserSummaryItem[];
}

/**
 * Validates whether assigning managerId to userId is valid (S05).
 * Refuses self-assignment, nonexistent manager, or cycle formation.
 */
export async function assertManagerAssignable(
  userId: string | Types.ObjectId,
  managerId: string | Types.ObjectId | null,
): Promise<void> {
  const userObjectId = new Types.ObjectId(userId);

  if (!managerId) {
    return; // Setting manager to null (top of tree) is always valid
  }

  const managerObjectId = new Types.ObjectId(managerId);

  if (userObjectId.equals(managerObjectId)) {
    throw new Error('A person cannot be their own manager (self-reporting is not allowed)');
  }

  const manager = await User.findById(managerObjectId).exec();
  if (!manager) {
    throw new Error('Assigned manager does not exist');
  }

  if (!manager.active) {
    throw new Error('Assigned manager is deactivated');
  }

  // Detect cycle by walking up the management tree from proposed manager
  let currentId: Types.ObjectId | null = manager.managerId as Types.ObjectId | null;
  const visited = new Set<string>([userObjectId.toHexString(), managerObjectId.toHexString()]);

  while (currentId) {
    if (currentId.equals(userObjectId)) {
      throw new Error('Cannot assign manager: this would create a circular reporting line');
    }
    const currentHex = currentId.toHexString();
    if (visited.has(currentHex)) {
      break;
    }
    visited.add(currentHex);

    const ancestor = await User.findById(currentId).select('managerId').lean().exec();
    currentId = ancestor?.managerId ? (ancestor.managerId as Types.ObjectId) : null;
  }
}

export async function updateUserManager(
  actorId: string | Types.ObjectId | null,
  userId: string | Types.ObjectId,
  managerId: string | Types.ObjectId | null,
): Promise<UserSummaryItem> {
  const user = await User.findById(userId).exec();
  if (!user) {
    throw new Error('User not found');
  }

  await assertManagerAssignable(user._id, managerId);

  const previousManager = user.managerId ? user.managerId.toHexString() : null;
  user.managerId = managerId ? new Types.ObjectId(managerId) : null;
  await user.save();

  await writeAudit({
    userId: actorId,
    action: 'org.manager_assigned',
    resourceType: 'user',
    resourceId: user._id.toHexString(),
    details: {
      fromManagerId: previousManager,
      toManagerId: managerId ? String(managerId) : null,
    },
  });

  return serializeUserSummary(user);
}

export async function getOrgChart(): Promise<OrgChartResponse> {
  const users = await User.find({ active: true }).sort({ 'profile.fullName': 1, email: 1 }).exec();

  const userMap = new Map<string, OrgTreeNode>();
  const summaries = users.map(serializeUserSummary);

  for (const s of summaries) {
    userMap.set(s.id, {
      ...s,
      directReports: [],
    });
  }

  const roots: OrgTreeNode[] = [];
  const unassigned: UserSummaryItem[] = [];

  for (const node of userMap.values()) {
    if (!node.managerId) {
      // Top of hierarchy or unassigned
      roots.push(node);
    } else {
      const parent = userMap.get(node.managerId);
      if (parent) {
        parent.directReports.push(node);
      } else {
        // Manager not found or inactive
        unassigned.push(node);
      }
    }
  }

  return {
    tree: roots,
    unassigned,
  };
}
