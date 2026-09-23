import { type FilterQuery } from 'mongoose';
import { User, type UserDocument } from '../models/user.js';
import type { UserQueryInput } from '@/shared';

export interface UserSummaryItem {
  id: string;
  email: string;
  username: string;
  role: string;
  customRoleId?: string | null;
  active: boolean;
  fullName: string;
  department: string;
  phone: string;
  pictureUrl: string | null;
  managerId: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface UserDirectoryResult {
  users: UserSummaryItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
}

export function serializeUserSummary(doc: any): UserSummaryItem {
  const id = doc._id?.toHexString ? doc._id.toHexString() : String(doc._id ?? '');
  const managerId = doc.managerId
    ? (doc.managerId.toHexString ? doc.managerId.toHexString() : doc.managerId.toString())
    : null;
  return {
    id,
    email: doc.email,
    username: doc.username,
    role: doc.role,
    customRoleId: doc.customRoleId ? doc.customRoleId.toString() : null,
    active: doc.active,
    fullName: doc.profile?.fullName ?? '',
    department: doc.profile?.department ?? '',
    phone: doc.profile?.phone ?? '',
    pictureUrl: doc.profile?.pictureUrl ?? null,
    managerId,
    lastLoginAt: doc.lastLoginAt ?? null,
    createdAt: (doc as any).createdAt ?? new Date(),
  };
}

export async function queryUserDirectory(input: UserQueryInput): Promise<UserDirectoryResult> {
  const filter: FilterQuery<UserDocument> = {};

  if (typeof input.active === 'boolean') {
    filter.active = input.active;
  }

  if (input.role) {
    filter.role = input.role;
  }

  if (input.department) {
    filter['profile.department'] = input.department;
  }

  if (input.search) {
    const term = input.search.trim();
    const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { email: regex },
      { username: regex },
      { 'profile.fullName': regex },
    ];
  }

  const offset = (input.page - 1) * input.pageSize;
  const sortDirection = input.order === 'asc' ? 1 : -1;
  const sortField =
    input.sort === 'name'
      ? 'profile.fullName'
      : input.sort === 'email'
      ? 'email'
      : input.sort === 'role'
      ? 'role'
      : 'createdAt';

  const [facetResult] = await User.aggregate<{
    data: any[];
    total: Array<{ count: number }>;
  }>([
    { $match: filter },
    {
      $facet: {
        data: [
          { $sort: { [sortField]: sortDirection, _id: 1 } },
          { $skip: offset },
          { $limit: input.pageSize },
        ],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  const total = facetResult?.total[0]?.count ?? 0;
  const docs = facetResult?.data ?? [];

  return {
    users: docs.map(serializeUserSummary),
    total,
    page: input.page,
    pageSize: input.pageSize,
    totalPages: Math.max(1, Math.ceil(total / input.pageSize)),
    hasMore: offset + docs.length < total,
  };
}
