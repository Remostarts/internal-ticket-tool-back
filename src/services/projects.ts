import { Project } from '../models/project.js';
import { User } from '../models/user.js';
import { Ticket } from '../models/ticket.js';
import { Task } from '../models/task.js';
import { ProjectLink } from '../models/project-link.js';
import { ProjectAsset } from '../models/project-asset.js';
import { hashPassword } from './password.js';
import { writeAudit } from './audit.js';
import type { CreateProjectInput, UpdateProjectInput, CreateClientAccountInput } from '@/shared';

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  clientName: string;
  description: string;
  status: string;
  memberCount: number;
  createdAt: Date;
}

export function serializeProject(doc: any): ProjectSummary {
  const id = doc._id?.toHexString ? doc._id.toHexString() : String(doc._id ?? '');
  return {
    id,
    name: doc.name,
    slug: doc.slug,
    clientName: doc.clientName,
    description: doc.description,
    status: doc.status,
    memberCount: doc.members?.length ?? 0,
    createdAt: (doc as any).createdAt ?? new Date(),
  };
}

export async function listProjects(user: { role: string; kind?: string | null; projectIds?: any }): Promise<ProjectSummary[]> {
  const filter: any = {};
  if (user.kind === 'client' && user.role !== 'admin') {
    filter._id = { $in: user.projectIds ?? [] };
  }

  const projects = await Project.find(filter).sort({ name: 1 }).lean().exec();
  return projects.map(serializeProject);
}

export async function createProject(actorId: string | null, input: CreateProjectInput): Promise<ProjectSummary> {
  const existing = await Project.findOne({ slug: input.slug }).lean().exec();
  if (existing) {
    const error: any = new Error('A project with this slug already exists.');
    error.statusCode = 409;
    error.httpStatus = 409;
    throw error;
  }

  let project;
  try {
    project = await Project.create({
      name: input.name,
      slug: input.slug,
      clientName: input.clientName,
      description: input.description,
      status: 'active',
      members: [],
    });
  } catch (err: any) {
    if (err?.code === 11000) {
      const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || 'slug';
      const error: any = new Error(`A project with this ${field} already exists.`);
      error.statusCode = 409;
      error.httpStatus = 409;
      throw error;
    }
    throw err;
  }

  await writeAudit({
    userId: actorId,
    action: 'project.created',
    resourceType: 'project',
    resourceId: project._id.toHexString(),
    details: { name: project.name, slug: project.slug, clientName: project.clientName },
  });

  return serializeProject(project);
}

export async function updateProject(
  actorId: string | null,
  projectId: string,
  input: UpdateProjectInput,
): Promise<ProjectSummary> {
  const project = await Project.findById(projectId).exec();
  if (!project) throw new Error('Project not found');

  if (input.name !== undefined) project.name = input.name;
  if (input.clientName !== undefined) project.clientName = input.clientName;
  if (input.description !== undefined) project.description = input.description;
  if (input.status !== undefined) project.status = input.status;

  await project.save();

  await writeAudit({
    userId: actorId,
    action: 'project.updated',
    resourceType: 'project',
    resourceId: project._id.toHexString(),
    details: input as any,
  });

  return serializeProject(project);
}

export async function createClientAccount(
  actorId: string | null,
  input: CreateClientAccountInput,
): Promise<{ id: string; email: string; username: string }> {
  const project = await Project.findById(input.projectId).exec();
  if (!project) throw new Error('Project not found');

  const existingEmail = await User.findOne({ email: input.email }).lean().exec();
  if (existingEmail) {
    const error: any = new Error('Email already registered');
    error.statusCode = 409;
    error.httpStatus = 409;
    throw error;
  }

  const existingUsername = await User.findOne({ username: input.username }).lean().exec();
  if (existingUsername) {
    const error: any = new Error('Username already taken');
    error.statusCode = 409;
    error.httpStatus = 409;
    throw error;
  }

  const passwordHash = await hashPassword(input.password);

  let clientUser;
  try {
    clientUser = await User.create({
      email: input.email,
      username: input.username,
      passwordHash,
      role: 'client',
      kind: 'client',
      clientId: project.clientName,
      projectIds: [project._id],
      active: true,
      profile: {
        fullName: input.fullName,
        phone: input.phone,
        department: project.clientName,
      },
    });
  } catch (err: any) {
    if (err?.code === 11000) {
      const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || 'email';
      const error: any = new Error(`A user with this ${field} already exists.`);
      error.statusCode = 409;
      error.httpStatus = 409;
      throw error;
    }
    throw err;
  }

  if (!project.members.some((m) => m.equals(clientUser._id))) {
    project.members.push(clientUser._id);
    await project.save();
  }

  await writeAudit({
    userId: actorId,
    action: 'client.account_created',
    resourceType: 'user',
    resourceId: clientUser._id.toHexString(),
    details: { email: clientUser.email, projectId: project._id.toHexString() },
  });

  return {
    id: clientUser._id.toHexString(),
    email: clientUser.email,
    username: clientUser.username,
  };
}

export async function deleteProjectById(actorId: string | null, projectId: string): Promise<{ deleted: boolean; projectName: string }> {
  const project = await Project.findById(projectId).lean().exec();
  if (!project) {
    return { deleted: false, projectName: '' };
  }

  const projectName = project.name;

  // Clean up associated resources
  await Promise.all([
    Ticket.deleteMany({ project: project._id }),
    Task.deleteMany({ project: project._id }),
    ProjectLink.deleteMany({ project: project._id }),
    ProjectAsset.deleteMany({ project: project._id }),
    User.updateMany({ projectIds: project._id }, { $pull: { projectIds: project._id } }),
    Project.findByIdAndDelete(project._id),
  ]);

  await writeAudit({
    userId: actorId,
    action: 'project.deleted',
    resourceType: 'project',
    resourceId: (project as any)._id?.toHexString ? (project as any)._id.toHexString() : String((project as any)._id),
    details: { name: projectName, slug: project.slug },
  });

  return { deleted: true, projectName };
}

export async function deleteProjectsByNamesOrSlugs(
  actorId: string | null,
  namesOrSlugs: string[],
): Promise<{ deletedCount: number; deletedProjects: string[] }> {
  const deletedProjects: string[] = [];

  for (const item of namesOrSlugs) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    // Match exact name, case-insensitive name, or slug
    const regex = new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const projects = await Project.find({
      $or: [{ name: regex }, { slug: regex }],
    }).lean().exec();

    for (const proj of projects) {
      await deleteProjectById(actorId, (proj as any)._id?.toHexString ? (proj as any)._id.toHexString() : String((proj as any)._id));
      deletedProjects.push(proj.name);
    }
  }

  return { deletedCount: deletedProjects.length, deletedProjects };
}
