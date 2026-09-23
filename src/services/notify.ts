import { NotificationSetting } from '../models/notification-setting.js';
import { logger } from '../logging/logger.js';
import type { UpdateNotificationSettingsInput } from '@/shared';

export interface NotificationPayload {
  type: 'ticketCreated' | 'ticketClaimed' | 'ticketResolved' | 'ticketEscalated';
  reference: string;
  recipientEmail?: string;
  summary: string;
}

export async function sendNotification(payload: NotificationPayload): Promise<void> {
  try {
    const setting = await NotificationSetting.findOne().exec();
    if (setting && setting[payload.type] === false) {
      logger.info({ type: payload.type, reference: payload.reference }, 'Notification skipped due to settings switch');
      return;
    }

    logger.info(
      { type: payload.type, reference: payload.reference, summary: payload.summary },
      'Notification dispatched (save first, mail second)',
    );
  } catch (err) {
    logger.error({ err, type: payload.type }, 'Failed to dispatch notification; continuing request');
  }
}

export async function getNotificationSettings(): Promise<any> {
  let setting = await NotificationSetting.findOne().exec();
  if (!setting) {
    setting = await NotificationSetting.create({
      ticketCreated: true,
      ticketClaimed: true,
      ticketResolved: true,
      ticketEscalated: true,
    });
  }
  return setting;
}

export async function updateNotificationSettings(input: UpdateNotificationSettingsInput): Promise<any> {
  let setting = await NotificationSetting.findOne().exec();
  if (!setting) {
    setting = await NotificationSetting.create(input);
  } else {
    if (input.ticketCreated !== undefined) setting.ticketCreated = input.ticketCreated;
    if (input.ticketClaimed !== undefined) setting.ticketClaimed = input.ticketClaimed;
    if (input.ticketResolved !== undefined) setting.ticketResolved = input.ticketResolved;
    if (input.ticketEscalated !== undefined) setting.ticketEscalated = input.ticketEscalated;
    await setting.save();
  }
  return setting;
}
