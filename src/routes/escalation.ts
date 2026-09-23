import { Router } from 'express';
import {
  escalationRuleSchema,
  auditExportQuerySchema,
} from '@/shared';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePermission } from '../middleware/require-permission.js';
import {
  getEscalationRules,
  saveEscalationRule,
  runEscalationPass,
} from '../services/escalation-rules.js';
import { exportAuditTrail } from '../services/audit-export.js';

export function createEscalationRouter(): Router {
  const router = Router();

  // Get escalation rules
  router.get(
    '/api/escalation/rules',
    requireAuth,
    requirePermission('escalation:read'),
    asyncHandler(async (req, res) => {
      const projectId = req.query.projectId as string | undefined;
      const rules = await getEscalationRules(projectId);
      res.status(200).json(rules);
    }),
  );

  // Save/configure escalation rule
  router.post(
    '/api/escalation/rules',
    requireAuth,
    requirePermission('escalation:write'),
    asyncHandler(async (req, res) => {
      const input = escalationRuleSchema.parse(req.body);
      const saved = await saveEscalationRule(input, req.sessionUser?.id ?? null);
      res.status(201).json(saved);
    }),
  );

  // Trigger manual escalation pass (or called by cron scheduler)
  router.post(
    '/api/escalation/run',
    requireAuth,
    requirePermission('escalation:write'),
    asyncHandler(async (_req, res) => {
      const result = await runEscalationPass();
      res.status(200).json(result);
    }),
  );

  // Export audit trail (CSV / JSON)
  router.get(
    '/api/audit/export',
    requireAuth,
    requirePermission('audit:read'),
    asyncHandler(async (req, res) => {
      const query = auditExportQuerySchema.parse(req.query);
      const content = await exportAuditTrail(query);

      if (query.format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="audit-trail.csv"');
        res.status(200).send(content);
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.status(200).send(content);
      }
    }),
  );

  return router;
}
