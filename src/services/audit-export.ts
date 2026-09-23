import { Types } from 'mongoose';
import { AuditLog } from '../models/audit-log.js';
import type { AuditExportQueryInput } from '@/shared';

export async function exportAuditTrail(input: AuditExportQueryInput): Promise<string> {
  const filter: any = {};
  if (input.actor && Types.ObjectId.isValid(input.actor)) {
    filter.user = new Types.ObjectId(input.actor);
  }
  if (input.action) {
    filter.action = input.action;
  }
  if (input.startDate || input.endDate) {
    filter.timestamp = {};
    if (input.startDate) filter.timestamp.$gte = new Date(input.startDate);
    if (input.endDate) filter.timestamp.$lte = new Date(input.endDate);
  }

  const logs = await AuditLog.find(filter)
    .sort({ timestamp: -1 })
    .limit(1000)
    .populate('user', 'username email')
    .lean()
    .exec();

  if (input.format === 'json') {
    return JSON.stringify(logs, null, 2);
  }

  // Format CSV
  const headers = ['ID', 'Timestamp', 'Actor', 'Email', 'Action', 'ResourceType', 'ResourceId', 'Details'];
  const rows = logs.map((log: any) => {
    const actorName = log.user?.username ?? 'system';
    const actorEmail = log.user?.email ?? '—';
    const detailsStr = JSON.stringify(log.details ?? {}).replace(/"/g, '""');
    return [
      log._id.toString(),
      new Date(log.timestamp).toISOString(),
      `"${actorName}"`,
      `"${actorEmail}"`,
      `"${log.action}"`,
      `"${log.resourceType ?? ''}"`,
      `"${log.resourceId ?? ''}"`,
      `"${detailsStr}"`,
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}
