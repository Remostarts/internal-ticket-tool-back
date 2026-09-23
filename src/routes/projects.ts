import { Router } from 'express';
import {
  createProjectSchema,
  updateProjectSchema,
  createClientAccountSchema,
  createProjectLinkSchema,
  updateProjectLinkSchema,
  reorderProjectLinksSchema,
  createProjectAssetSchema,
  updateProjectAssetSchema,
} from '@/shared';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePermission } from '../middleware/require-permission.js';
import {
  listProjects,
  createProject,
  updateProject,
  deleteProjectById,
  deleteProjectsByNamesOrSlugs,
  createClientAccount,
} from '../services/projects.js';
import {
  listProjectLinks,
  createProjectLink,
  updateProjectLink,
  deleteProjectLink,
  reorderProjectLinks,
} from '../services/project-links.js';
import {
  listProjectAssets,
  createProjectAsset,
  updateProjectAsset,
  deleteProjectAsset,
} from '../services/project-assets.js';
import { computeProjectProgress } from '../services/project-progress.js';

export function createProjectsRouter(): Router {
  const router = Router();

  // List projects accessible to caller
  router.get(
    '/api/projects',
    requireAuth,
    requirePermission('projects:read'),
    asyncHandler(async (req, res) => {
      const projects = await listProjects(req.sessionUser as any);
      res.status(200).json(projects);
    }),
  );

  // Create project (Admin / Management)
  router.post(
    '/api/projects',
    requireAuth,
    requirePermission('projects:write'),
    asyncHandler(async (req, res) => {
      const input = createProjectSchema.parse(req.body);
      const project = await createProject(req.sessionUser?.id ?? null, input);
      res.status(201).json(project);
    }),
  );

  // Update project
  router.patch(
    '/api/projects/:id',
    requireAuth,
    requirePermission('projects:write'),
    asyncHandler(async (req, res) => {
      const input = updateProjectSchema.parse(req.body);
      const updated = await updateProject(req.sessionUser?.id ?? null, req.params.id as string, input);
      res.status(200).json(updated);
    }),
  );

  // Delete project
  router.delete(
    '/api/projects/:id',
    requireAuth,
    requirePermission('projects:write'),
    asyncHandler(async (req, res) => {
      const result = await deleteProjectById(req.sessionUser?.id ?? null, req.params.id as string);
      res.status(200).json(result);
    }),
  );

  // Purge multiple projects by name or slug
  router.post(
    '/api/projects/purge-by-names',
    requireAuth,
    requirePermission('projects:write'),
    asyncHandler(async (req, res) => {
      const names = Array.isArray(req.body.names) ? req.body.names : [];
      const result = await deleteProjectsByNamesOrSlugs(req.sessionUser?.id ?? null, names);
      res.status(200).json(result);
    }),
  );

  // Create Client login for project
  router.post(
    '/api/projects/client-account',
    requireAuth,
    requirePermission('projects:write'),
    asyncHandler(async (req, res) => {
      const input = createClientAccountSchema.parse(req.body);
      const result = await createClientAccount(req.sessionUser?.id ?? null, input);
      res.status(201).json(result);
    }),
  );

  // Project Links / Documentation Hub
  router.get(
    '/api/projects/:id/links',
    requireAuth,
    requirePermission('projects:read'),
    asyncHandler(async (req, res) => {
      const links = await listProjectLinks(req.sessionUser as any, req.params.id as string);
      res.status(200).json(links);
    }),
  );

  router.post(
    '/api/projects/:id/links',
    requireAuth,
    requirePermission('projects:read'),
    asyncHandler(async (req, res) => {
      const input = createProjectLinkSchema.parse({ ...req.body, projectId: req.params.id });
      const link = await createProjectLink(req.sessionUser as any, input);
      res.status(201).json(link);
    }),
  );

  router.patch(
    '/api/projects/:id/links/:linkId',
    requireAuth,
    requirePermission('projects:read'),
    asyncHandler(async (req, res) => {
      const input = updateProjectLinkSchema.parse(req.body);
      const updated = await updateProjectLink(req.sessionUser as any, req.params.linkId as string, input);
      res.status(200).json(updated);
    }),
  );

  router.delete(
    '/api/projects/:id/links/:linkId',
    requireAuth,
    requirePermission('projects:read'),
    asyncHandler(async (req, res) => {
      await deleteProjectLink(req.sessionUser as any, req.params.linkId as string);
      res.status(200).json({ ok: true });
    }),
  );

  router.post(
    '/api/projects/:id/links/reorder',
    requireAuth,
    requirePermission('projects:read'),
    asyncHandler(async (req, res) => {
      const input = reorderProjectLinksSchema.parse(req.body);
      const links = await reorderProjectLinks(req.sessionUser as any, req.params.id as string, input.linkIds);
      res.status(200).json(links);
    }),
  );

  // Project Progress from Board tasks
  router.get(
    '/api/projects/:id/progress',
    requireAuth,
    requirePermission('projects:read'),
    asyncHandler(async (req, res) => {
      const progress = await computeProjectProgress(req.sessionUser as any, req.params.id as string);
      res.status(200).json(progress);
    }),
  );

  // Project Assets
  router.get(
    '/api/projects/:id/assets',
    requireAuth,
    requirePermission('projects:read'),
    asyncHandler(async (req, res) => {
      const assets = await listProjectAssets(req.sessionUser as any, req.params.id as string);
      res.status(200).json(assets);
    }),
  );

  router.post(
    '/api/projects/:id/assets',
    requireAuth,
    requirePermission('projects:write'),
    asyncHandler(async (req, res) => {
      const input = createProjectAssetSchema.parse({ ...req.body, projectId: req.params.id });
      const asset = await createProjectAsset(req.sessionUser as any, input);
      res.status(201).json(asset);
    }),
  );

  router.patch(
    '/api/projects/:id/assets/:assetId',
    requireAuth,
    requirePermission('projects:write'),
    asyncHandler(async (req, res) => {
      const input = updateProjectAssetSchema.parse(req.body);
      const updated = await updateProjectAsset(req.sessionUser as any, req.params.assetId as string, input);
      res.status(200).json(updated);
    }),
  );

  router.delete(
    '/api/projects/:id/assets/:assetId',
    requireAuth,
    requirePermission('projects:write'),
    asyncHandler(async (req, res) => {
      await deleteProjectAsset(req.sessionUser as any, req.params.assetId as string);
      res.status(200).json({ ok: true });
    }),
  );

  return router;
}
