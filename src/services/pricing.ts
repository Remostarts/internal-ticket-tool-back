import { Types } from 'mongoose';
import { FeaturePricing, type FeaturePricingDocument } from '../models/feature-pricing.js';
import { assertProjectAccess, type ScopedUser } from './project-scope.js';
import { writeAudit } from './audit.js';
import {
  formatUsd,
  type CreatePricingInput,
  type UpdatePricingInput,
  type ProjectPricingSummary,
} from '@/shared';

export function serializePricing(doc: FeaturePricingDocument) {
  return {
    id: doc._id.toHexString(),
    projectId: doc.project ? doc.project.toString() : '',
    serviceName: doc.serviceName,
    description: doc.description,
    serviceType: doc.serviceType as any,
    monthlyCostCents: doc.monthlyCostCents,
    monthlyCostFormatted: formatUsd(doc.monthlyCostCents),
    isActive: doc.isActive,
    createdAt: (doc as any).createdAt ?? new Date(),
  };
}

export async function getProjectPricing(user: ScopedUser, projectId: string): Promise<ProjectPricingSummary> {
  await assertProjectAccess(user, projectId);

  const query: any = { project: new Types.ObjectId(projectId) };
  // If client, show active only
  if (user.kind === 'client' && user.role !== 'admin') {
    query.isActive = true;
  }

  const items = await FeaturePricing.find(query).sort({ serviceName: 1 }).exec();
  const serialized = items.map(serializePricing);

  const totalMonthlyCostCents = items.reduce((sum, item) => (item.isActive ? sum + item.monthlyCostCents : sum), 0);

  return {
    items: serialized,
    totalMonthlyCostCents,
    totalMonthlyCostFormatted: formatUsd(totalMonthlyCostCents),
  };
}

export async function createPricingItem(user: ScopedUser, input: CreatePricingInput) {
  const project = await assertProjectAccess(user, input.projectId);

  const item = await FeaturePricing.create({
    project: project._id,
    serviceName: input.serviceName,
    description: input.description,
    serviceType: input.serviceType,
    monthlyCostCents: input.monthlyCostCents,
    isActive: input.isActive,
  });

  await writeAudit({
    userId: user.id,
    action: 'pricing.created',
    resourceType: 'pricing',
    resourceId: item._id.toHexString(),
    details: { serviceName: input.serviceName, monthlyCostCents: input.monthlyCostCents },
  });

  return serializePricing(item);
}

export async function updatePricingItem(user: ScopedUser, itemId: string, input: UpdatePricingInput) {
  const item = await FeaturePricing.findById(itemId).exec();
  if (!item) {
    const error: any = new Error('Pricing item not found');
    error.statusCode = 404;
    throw error;
  }

  await assertProjectAccess(user, item.project.toString());

  if (input.serviceName !== undefined) item.serviceName = input.serviceName;
  if (input.description !== undefined) item.description = input.description;
  if (input.serviceType !== undefined) item.serviceType = input.serviceType;
  if (input.monthlyCostCents !== undefined) item.monthlyCostCents = input.monthlyCostCents;
  if (input.isActive !== undefined) item.isActive = input.isActive;

  await item.save();

  await writeAudit({
    userId: user.id,
    action: 'pricing.updated',
    resourceType: 'pricing',
    resourceId: item._id.toHexString(),
  });

  return serializePricing(item);
}

export async function deletePricingItem(user: ScopedUser, itemId: string): Promise<void> {
  const item = await FeaturePricing.findById(itemId).exec();
  if (!item) {
    const error: any = new Error('Pricing item not found');
    error.statusCode = 404;
    throw error;
  }

  await assertProjectAccess(user, item.project.toString());

  await FeaturePricing.deleteOne({ _id: item._id }).exec();

  await writeAudit({
    userId: user.id,
    action: 'pricing.deleted',
    resourceType: 'pricing',
    resourceId: itemId,
  });
}
