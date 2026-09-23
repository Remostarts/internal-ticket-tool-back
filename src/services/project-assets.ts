import { Types } from 'mongoose';
import { ProjectAsset } from '../models/project-asset.js';
import { assertProjectAccess, type ScopedUser } from './project-scope.js';
import { writeAudit } from './audit.js';
import type { CreateProjectAssetInput, UpdateProjectAssetInput } from '@/shared';

export interface ProjectAssetSummary {
  id: string;
  projectId: string;
  type: string;
  title: string;
  fileUrl: string | null;
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  featureBreakdown?: Array<{
    featureName: string;
    phase: string;
    description: string;
  }>;
  createdAt: Date;
}

export function serializeProjectAsset(doc: any): ProjectAssetSummary {
  const id = doc._id?.toHexString ? doc._id.toHexString() : String(doc._id ?? '');
  return {
    id,
    projectId: doc.project ? doc.project.toString() : '',
    type: doc.type,
    title: doc.title,
    fileUrl: doc.fileUrl ?? null,
    fileName: doc.fileName,
    fileSizeBytes: doc.fileSizeBytes,
    mimeType: doc.mimeType,
    featureBreakdown: doc.featureBreakdown
      ? doc.featureBreakdown.map((f: any) => ({
          featureName: f.featureName,
          phase: f.phase,
          description: f.description ?? '',
        }))
      : undefined,
    createdAt: (doc as any).createdAt ?? new Date(),
  };
}

export async function listProjectAssets(user: ScopedUser, projectId: string): Promise<ProjectAssetSummary[]> {
  await assertProjectAccess(user, projectId);
  const assets = await ProjectAsset.find({ project: new Types.ObjectId(projectId) })
    .sort({ createdAt: -1 })
    .lean()
    .exec();
  return assets.map(serializeProjectAsset);
}

export async function createProjectAsset(user: ScopedUser, input: CreateProjectAssetInput): Promise<ProjectAssetSummary> {
  const project = await assertProjectAccess(user, input.projectId);

  const asset = await ProjectAsset.create({
    project: project._id,
    type: input.type,
    title: input.title,
    fileUrl: input.fileUrl ?? null,
    fileName: input.fileName,
    fileSizeBytes: input.fileSizeBytes,
    mimeType: input.mimeType,
    featureBreakdown: input.featureBreakdown ?? [],
  });

  await writeAudit({
    userId: user.id,
    action: 'project_asset.created',
    resourceType: 'project_asset',
    resourceId: asset._id.toHexString(),
    details: { type: input.type, title: input.title },
  });

  return serializeProjectAsset(asset);
}

export async function updateProjectAsset(
  user: ScopedUser,
  assetId: string,
  input: UpdateProjectAssetInput,
): Promise<ProjectAssetSummary> {
  const asset = await ProjectAsset.findById(assetId).exec();
  if (!asset) {
    const error: any = new Error('Asset not found');
    error.statusCode = 404;
    throw error;
  }

  await assertProjectAccess(user, asset.project.toString());

  if (input.title !== undefined) asset.title = input.title;
  if (input.type !== undefined) asset.type = input.type;
  if (input.fileUrl !== undefined) asset.fileUrl = input.fileUrl ?? null;
  if (input.fileName !== undefined) asset.fileName = input.fileName;
  if (input.fileSizeBytes !== undefined) asset.fileSizeBytes = input.fileSizeBytes;
  if (input.mimeType !== undefined) asset.mimeType = input.mimeType;
  if (input.featureBreakdown !== undefined) asset.featureBreakdown = input.featureBreakdown as any;

  await asset.save();

  await writeAudit({
    userId: user.id,
    action: 'project_asset.updated',
    resourceType: 'project_asset',
    resourceId: asset._id.toHexString(),
  });

  return serializeProjectAsset(asset);
}

export async function deleteProjectAsset(user: ScopedUser, assetId: string): Promise<void> {
  const asset = await ProjectAsset.findById(assetId).lean().exec();
  if (!asset) {
    const error: any = new Error('Asset not found');
    error.statusCode = 404;
    throw error;
  }

  await assertProjectAccess(user, asset.project.toString());

  await ProjectAsset.deleteOne({ _id: (asset as any)._id }).exec();

  await writeAudit({
    userId: user.id,
    action: 'project_asset.deleted',
    resourceType: 'project_asset',
    resourceId: assetId,
  });
}
