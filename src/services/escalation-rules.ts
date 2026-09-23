import { Types } from 'mongoose';
import { EscalationRule, type EscalationRuleDocument } from '../models/escalation-rule.js';
import { Ticket } from '../models/ticket.js';
import { User } from '../models/user.js';
import { transitionTicket } from './ticket-state.js';
import { sendNotification } from './notify.js';
import { writeAudit } from './audit.js';
import { logger } from '../logging/logger.js';
import type { EscalationRuleInput } from '@/shared';

export const DEFAULT_LADDER = [
  { fromRole: 'developer', toRole: 'manager', triggerHours: 24, p1TriggerHours: 4 },
  { fromRole: 'manager', toRole: 'management', triggerHours: 24, p1TriggerHours: 4 },
  { fromRole: 'management', toRole: 'ceo', triggerHours: 24, p1TriggerHours: 4 },
  { fromRole: 'ceo', toRole: 'cto', triggerHours: 24, p1TriggerHours: 4 },
];

export async function getEscalationRules(projectId?: string | null): Promise<EscalationRuleDocument[]> {
  let rules = await EscalationRule.find({ project: projectId ? new Types.ObjectId(projectId) : null, isActive: true }).exec();
  if (rules.length === 0 && projectId) {
    // Fall back to org-wide rules
    rules = await EscalationRule.find({ project: null, isActive: true }).exec();
  }

  if (rules.length === 0) {
    // Seed defaults if nothing exists
    for (const d of DEFAULT_LADDER) {
      await EscalationRule.create({ ...d, project: null, isActive: true });
    }
    rules = await EscalationRule.find({ project: null, isActive: true }).exec();
  }

  return rules;
}

export async function saveEscalationRule(input: EscalationRuleInput, actorId: string | null): Promise<any> {
  const rule = await EscalationRule.create({
    project: input.projectId ? new Types.ObjectId(input.projectId) : null,
    fromRole: input.fromRole,
    toRole: input.toRole,
    triggerHours: input.triggerHours,
    p1TriggerHours: input.p1TriggerHours,
    isActive: input.isActive,
  });

  await writeAudit({
    userId: actorId,
    action: 'escalation.rule_created',
    resourceType: 'escalation_rule',
    resourceId: rule._id.toHexString(),
    details: input as any,
  });

  return rule;
}

/**
 * Evaluates open tickets and automatically advances idle tickets along the escalation ladder (M003, R043).
 */
export async function runEscalationPass(now: Date = new Date()): Promise<{ evaluated: number; escalated: number }> {
  const openTickets = await Ticket.find({
    status: { $in: ['new', 'in-progress', 'escalated'] },
  })
    .populate('assignee', 'role username')
    .exec();

  const rules = await getEscalationRules(null);
  let escalatedCount = 0;

  for (const ticket of openTickets) {
    const hoursIdle = (now.getTime() - new Date(ticket.lastActivityAt).getTime()) / (1000 * 60 * 60);
    const isP1 = ticket.priority === 'P1';

    const currentRole = (ticket.assignee as any)?.role || 'developer';
    const matchingRule = rules.find((r) => r.fromRole === currentRole);

    if (matchingRule) {
      const threshold = isP1 ? matchingRule.p1TriggerHours : matchingRule.triggerHours;
      if (hoursIdle >= threshold) {
        // Find target role member
        const nextStaff = await User.findOne({ role: matchingRule.toRole, active: true }).exec();

        ticket.escalationReason = `Automated idle escalation after ${hoursIdle.toFixed(1)} hours without activity.`;
        ticket.escalationTier = matchingRule.toRole;
        ticket.escalatedAt = now;
        ticket.lastActivityAt = now;
        if (nextStaff) {
          ticket.assignee = nextStaff._id;
        }

        await transitionTicket(
          ticket,
          'escalated',
          { id: ticket.requester.toString(), role: 'admin', kind: 'staff' },
          `Automated escalation: Stalled for ${hoursIdle.toFixed(0)}h. Handed over to ${matchingRule.toRole}.`,
        );

        void sendNotification({
          type: 'ticketEscalated',
          reference: ticket.reference,
          summary: `Auto-escalated to ${matchingRule.toRole} (${ticket.title})`,
        });

        escalatedCount++;
      }
    }
  }

  logger.info({ evaluated: openTickets.length, escalated: escalatedCount }, 'Escalation pass completed');
  return { evaluated: openTickets.length, escalated: escalatedCount };
}
