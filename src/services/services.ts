import { Types } from 'mongoose';
import { Service, type ServiceDocument } from '../models/service.js';
import { ServiceCheck } from '../models/service-check.js';
import { Incident } from '../models/incident.js';
import { assertProjectAccess, type ScopedUser } from './project-scope.js';
import { writeAudit } from './audit.js';
import { logger } from '../logging/logger.js';
import type { CreateServiceInput, ServiceStatus } from '@/shared';

export interface ServiceSummary {
  id: string;
  projectId: string;
  name: string;
  url: string;
  cadenceMinutes: number;
  degradedResponseMs: number;
  downAfterConsecutiveFailures: number;
  enabled: boolean;
  notes?: string;
  lastStatus: ServiceStatus;
  lastResponseMs?: number;
  lastCheckedAt?: Date;
  nextCheckAt: Date;
  uptime24h?: number;
}

export function serializeService(doc: any, uptime24h = 100): ServiceSummary {
  const id = doc._id?.toHexString ? doc._id.toHexString() : String(doc._id ?? '');
  return {
    id,
    projectId: doc.project?.toString() ?? '',
    name: doc.name,
    url: doc.url,
    cadenceMinutes: doc.cadenceMinutes,
    degradedResponseMs: doc.degradedResponseMs,
    downAfterConsecutiveFailures: doc.downAfterConsecutiveFailures,
    enabled: doc.enabled,
    notes: doc.notes,
    lastStatus: doc.lastStatus,
    lastResponseMs: doc.lastResponseMs,
    lastCheckedAt: doc.lastCheckedAt,
    nextCheckAt: doc.nextCheckAt,
    uptime24h,
  };
}

/**
 * Execute HTTP health probe for a single service.
 * Respects timeout and updates status, consecutive failures, and records sample.
 */
export async function checkService(service: ServiceDocument): Promise<ServiceStatus> {
  const start = Date.now();
  let status: ServiceStatus = 'up';
  let statusCode: number | undefined;
  let errorMsg: string | undefined;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(service.url, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    statusCode = res.status;
    const responseMs = Date.now() - start;

    if (!res.ok) {
      status = 'down';
      errorMsg = `HTTP status ${res.status}`;
    } else if (responseMs > service.degradedResponseMs) {
      status = 'degraded';
    } else {
      status = 'up';
    }
  } catch (err: any) {
    status = 'down';
    errorMsg = err.name === 'AbortError' ? 'Connection timed out (>8000ms)' : (err.message || 'Network error');
  }

  const responseMs = Date.now() - start;

  if (status === 'down') {
    service.consecutiveFailures += 1;
    if (service.consecutiveFailures < service.downAfterConsecutiveFailures) {
      status = 'degraded'; // Grace period before declaring full outage
    }
  } else {
    service.consecutiveFailures = 0;
  }

  const prevStatus = service.lastStatus;
  service.lastStatus = status;
  service.lastResponseMs = responseMs;
  service.lastCheckedAt = new Date();
  service.nextCheckAt = new Date(Date.now() + service.cadenceMinutes * 60 * 1000);
  await service.save();

  // Save sample
  await ServiceCheck.create({
    service: service._id,
    project: service.project,
    status,
    responseMs,
    statusCode,
    errorMessage: errorMsg,
    checkedAt: new Date(),
  });

  // Automated Incident Management (R051)
  if (status === 'down' && prevStatus !== 'down') {
    // Check if open incident already exists to avoid duplicate flapping incidents
    const existing = await Incident.findOne({ service: service._id, status: 'open' }).exec();
    if (!existing) {
      await Incident.create({
        service: service._id,
        project: service.project,
        title: `Outage detected on ${service.name}`,
        summary: `Automated health check failed with error: ${errorMsg || 'Service unreachable'}.`,
        severity: 'major',
        status: 'open',
        openedAt: new Date(),
        isAutomated: true,
        timeline: [
          {
            timestamp: new Date(),
            message: `Outage detected after ${service.consecutiveFailures} consecutive failure(s).`,
            actor: 'System Health Checker',
          },
        ],
      });
      logger.warn({ service: service.name }, 'Opened automated service incident');
    }
  } else if (status === 'up' && (prevStatus === 'down' || prevStatus === 'degraded')) {
    // Auto-resolve open incident
    const openIncident = await Incident.findOne({ service: service._id, status: 'open' }).exec();
    if (openIncident) {
      openIncident.status = 'resolved';
      openIncident.resolvedAt = new Date();
      openIncident.resolutionNote = 'Automated check confirmed service has recovered and is healthy.';
      openIncident.timeline.push({
        timestamp: new Date(),
        message: 'Service recovered. Health checks passing.',
        actor: 'System Health Checker',
      });
      await openIncident.save();
      logger.info({ service: service.name }, 'Closed service incident after recovery');
    }
  }

  return status;
}

/**
 * List services for a user scope.
 */
export async function listServices(user: ScopedUser, projectId?: string): Promise<ServiceSummary[]> {
  const filter: any = {};
  if (projectId) {
    await assertProjectAccess(user, projectId);
    filter.project = new Types.ObjectId(projectId);
  } else if (user.kind === 'client') {
    filter.project = { $in: (user.projectIds ?? []).map((id) => new Types.ObjectId(id)) };
  }

  const docs = await Service.find(filter).sort({ name: 1 }).lean().exec();

  // Compute 24h uptime for each service
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const results: ServiceSummary[] = [];

  for (const doc of docs) {
    const [total, up] = await Promise.all([
      ServiceCheck.countDocuments({ service: doc._id, checkedAt: { $gte: yesterday } }).exec(),
      ServiceCheck.countDocuments({ service: doc._id, status: { $in: ['up', 'degraded'] }, checkedAt: { $gte: yesterday } }).exec(),
    ]);
    const uptime24h = total === 0 ? 100 : Math.round((up / total) * 100);
    results.push(serializeService(doc, uptime24h));
  }

  return results;
}

export async function createService(user: ScopedUser, input: CreateServiceInput): Promise<ServiceSummary> {
  await assertProjectAccess(user, input.projectId);

  const service = await Service.create({
    project: new Types.ObjectId(input.projectId),
    name: input.name,
    url: input.url,
    cadenceMinutes: input.cadenceMinutes,
    degradedResponseMs: input.degradedResponseMs,
    downAfterConsecutiveFailures: input.downAfterConsecutiveFailures,
    enabled: input.enabled,
    notes: input.notes,
    lastStatus: 'unknown',
    nextCheckAt: new Date(),
  });

  await writeAudit({
    userId: user.id,
    action: 'service.created',
    resourceType: 'service',
    resourceId: service._id.toHexString(),
    details: { name: service.name, url: service.url, project: input.projectId },
  });

  return serializeService(service);
}

export async function triggerManualCheck(user: ScopedUser, serviceId: string): Promise<ServiceSummary> {
  const service = await Service.findById(serviceId).exec();
  if (!service) throw new Error('Service not found');

  await assertProjectAccess(user, service.project.toString());
  await checkService(service);

  await writeAudit({
    userId: user.id,
    action: 'service.checked',
    resourceType: 'service',
    resourceId: service._id.toHexString(),
    details: { name: service.name, status: service.lastStatus },
  });

  return serializeService(service);
}
