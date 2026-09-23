import { Types } from 'mongoose';
import { ProjectLink, type ProjectLinkDocument } from '../models/project-link.js';
import { assertProjectAccess, type ScopedUser } from './project-scope.js';
import { writeAudit } from './audit.js';
import { AppError } from '../middleware/error-handler.js';
import type { CreateProjectLinkInput, UpdateProjectLinkInput } from '@/shared';

function assertCanManageLinks(user: ScopedUser): void {
  if (user.role === 'client' || user.kind === 'client') {
    throw new AppError('PERMISSION_DENIED', 'Your role does not allow this action.', {
      requiredPermission: 'projects:read',
      role: user.role,
    });
  }
}

export interface ProjectLinkSummary {
  id: string;
  projectId: string;
  kind: string;
  label: string;
  url: string;
  notes: string;
  position: number;
}

export function serializeProjectLink(doc: ProjectLinkDocument): ProjectLinkSummary {
  return {
    id: doc._id.toHexString(),
    projectId: doc.project ? doc.project.toString() : '',
    kind: doc.kind,
    label: doc.label,
    url: doc.url,
    notes: doc.notes,
    position: doc.position,
  };
}

export async function listProjectLinks(user: ScopedUser, projectId: string): Promise<ProjectLinkSummary[]> {
  await assertProjectAccess(user, projectId);
  const links = await ProjectLink.find({ project: new Types.ObjectId(projectId) })
    .sort({ position: 1, createdAt: 1 })
    .exec();
  return links.map(serializeProjectLink);
}

export async function createProjectLink(user: ScopedUser, input: CreateProjectLinkInput): Promise<ProjectLinkSummary> {
  assertCanManageLinks(user);
  const project = await assertProjectAccess(user, input.projectId);

  const highest = await ProjectLink.findOne({ project: project._id }).sort({ position: -1 }).exec();
  const position = input.position ?? (highest ? highest.position + 1 : 0);

  const link = await ProjectLink.create({
    project: project._id,
    kind: input.kind,
    label: input.label,
    url: input.url,
    notes: input.notes,
    position,
  });

  await writeAudit({
    userId: user.id,
    action: 'project_link.created',
    resourceType: 'project_link',
    resourceId: link._id.toHexString(),
    details: { kind: input.kind, label: input.label },
  });

  return serializeProjectLink(link);
}

export async function updateProjectLink(
  user: ScopedUser,
  linkId: string,
  input: UpdateProjectLinkInput,
): Promise<ProjectLinkSummary> {
  assertCanManageLinks(user);
  const link = await ProjectLink.findById(linkId).exec();
  if (!link) {
    const error: any = new Error('Link not found');
    error.statusCode = 404;
    throw error;
  }

  await assertProjectAccess(user, link.project.toString());

  if (input.label !== undefined) link.label = input.label;
  if (input.url !== undefined) link.url = input.url;
  if (input.kind !== undefined) link.kind = input.kind;
  if (input.notes !== undefined) link.notes = input.notes;
  if (input.position !== undefined) link.position = input.position;

  await link.save();

  await writeAudit({
    userId: user.id,
    action: 'project_link.updated',
    resourceType: 'project_link',
    resourceId: link._id.toHexString(),
  });

  return serializeProjectLink(link);
}

export async function deleteProjectLink(user: ScopedUser, linkId: string): Promise<void> {
  assertCanManageLinks(user);
  const link = await ProjectLink.findById(linkId).exec();
  if (!link) {
    const error: any = new Error('Link not found');
    error.statusCode = 404;
    throw error;
  }

  await assertProjectAccess(user, link.project.toString());

  await ProjectLink.deleteOne({ _id: link._id }).exec();

  await writeAudit({
    userId: user.id,
    action: 'project_link.deleted',
    resourceType: 'project_link',
    resourceId: linkId,
  });
}

export async function reorderProjectLinks(
  user: ScopedUser,
  projectId: string,
  linkIds: string[],
): Promise<ProjectLinkSummary[]> {
  assertCanManageLinks(user);
  await assertProjectAccess(user, projectId);

  const updates = linkIds.map((id, index) =>
    ProjectLink.updateOne(
      { _id: new Types.ObjectId(id), project: new Types.ObjectId(projectId) },
      { position: index },
    ).exec(),
  );

  await Promise.all(updates);

  return listProjectLinks(user, projectId);
}
