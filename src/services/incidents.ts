import { Types } from 'mongoose';
import { Incident } from '../models/incident.js';
import { Service } from '../models/service.js';
import { assertProjectAccess, type ScopedUser } from './project-scope.js';
import { writeAudit } from './audit.js';
import type { CreateIncidentInput, CloseIncidentInput } from '@/shared';

export interface IncidentSummary {
  id: string;
  serviceId: string;
  serviceName: string;
  projectId: string;
  title: string;
  summary: string;
  severity: string;
  status: string;
  openedAt: Date;
  resolvedAt?: Date;
  resolutionNote?: string;
  isAutomated: boolean;
  timeline: Array<{
    timestamp: Date;
    message: string;
    actor?: string;
  }>;
}

export function serializeIncident(doc: any): IncidentSummary {
  return {
    id: doc._id.toHexString(),
    serviceId: doc.service?._id ? doc.service._id.toHexString() : doc.service?.toString() ?? '',
    serviceName: doc.service?.name ?? 'Service',
    projectId: doc.project?.toString() ?? '',
    title: doc.title,
    summary: doc.summary,
    severity: doc.severity,
    status: doc.status,
    openedAt: doc.openedAt,
    resolvedAt: doc.resolvedAt,
    resolutionNote: doc.resolutionNote,
    isAutomated: doc.isAutomated ?? true,
    timeline: doc.timeline ?? [],
  };
}

export async function listIncidents(user: ScopedUser, projectId?: string): Promise<IncidentSummary[]> {
  const filter: any = {};
  if (projectId) {
    await assertProjectAccess(user, projectId);
    filter.project = new Types.ObjectId(projectId);
  } else if (user.kind === 'client') {
    filter.project = { $in: (user.projectIds ?? []).map((id) => new Types.ObjectId(id)) };
  }

  const docs = await Incident.find(filter)
    .sort({ openedAt: -1 })
    .populate('service', 'name')
    .limit(50)
    .exec();

  return docs.map(serializeIncident);
}

export async function createManualIncident(user: ScopedUser, input: CreateIncidentInput): Promise<IncidentSummary> {
  const service = await Service.findById(input.serviceId).exec();
  if (!service) throw new Error('Service not found');

  await assertProjectAccess(user, service.project.toString());

  const incident = await Incident.create({
    service: service._id,
    project: service.project,
    title: input.title,
    summary: input.summary,
    severity: input.severity,
    status: 'open',
    openedAt: new Date(),
    isAutomated: false,
    timeline: [
      {
        timestamp: new Date(),
        message: input.summary,
        actor: user.kind === 'client' ? 'Client' : 'Staff',
      },
    ],
  });

  await writeAudit({
    userId: user.id,
    action: 'incident.created',
    resourceType: 'incident',
    resourceId: incident._id.toHexString(),
    details: { service: service.name, title: incident.title },
  });

  const populated = await Incident.findById(incident._id).populate('service', 'name').exec();
  return serializeIncident(populated);
}

export async function resolveManualIncident(user: ScopedUser, incidentId: string, input: CloseIncidentInput): Promise<IncidentSummary> {
  const incident = await Incident.findById(incidentId).populate('service', 'name').exec();
  if (!incident) throw new Error('Incident not found');

  await assertProjectAccess(user, incident.project.toString());

  incident.status = 'resolved';
  incident.resolvedAt = new Date();
  incident.resolutionNote = input.resolutionNote;
  incident.timeline.push({
    timestamp: new Date(),
    message: `Resolved: ${input.resolutionNote}`,
    actor: 'Staff Operator',
  });
  await incident.save();

  await writeAudit({
    userId: user.id,
    action: 'incident.resolved',
    resourceType: 'incident',
    resourceId: incident._id.toHexString(),
    details: { resolutionNote: input.resolutionNote },
  });

  return serializeIncident(incident);
}
