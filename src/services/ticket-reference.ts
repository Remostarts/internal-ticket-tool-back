import { Counter } from '../models/counter.js';

/**
 * Generates quotable references in the exact format: TICKET-YYYYMMDD-#### (R026).
 * Uses an atomic MongoDB sequence counter per day to guarantee collision-free references.
 */
export async function generateTicketReference(date: Date = new Date()): Promise<string> {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const dayKey = `${yyyy}${mm}${dd}`;

  const counter = await Counter.findOneAndUpdate(
    { key: `ticket:${dayKey}` },
    { $inc: { sequence: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();

  const seq = String(counter.sequence).padStart(4, '0');
  return `TICKET-${dayKey}-${seq}`;
}
