import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { databaseState, type DatabaseState } from '../db/connect.js';

/**
 * The health probe (R010).
 *
 * Unauthenticated, and it answers whether or not the database is reachable - a
 * probe that goes dark exactly when something is wrong is worse than no probe.
 * `database` reports the live Mongoose connection state and `status` degrades
 * when it is not connected.
 *
 * Registered at both `/health` (the infrastructure probe, called directly) and
 * `/api/health` (the browser and server components, through the one-origin
 * Next.js rewrite which preserves the `/api` prefix). `HEALTH_PATHS` is exported
 * so the public allowlist in T04 cannot drift from what is actually mounted.
 */

export const HEALTH_PATHS = ['/health', '/api/health'] as const;

export interface HealthReport {
  status: 'ok' | 'degraded';
  database: DatabaseState;
  uptimeSeconds: number;
  version: string;
}

const PROCESS_STARTED_AT = Date.now();

function readVersion(): string {
  try {
    const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = readVersion();

export function buildHealthReport(): HealthReport {
  const database = databaseState();
  return {
    status: database === 'connected' ? 'ok' : 'degraded',
    database,
    uptimeSeconds: Math.max(0, Math.round((Date.now() - PROCESS_STARTED_AT) / 1000)),
    version: VERSION,
  };
}

export function createHealthRouter(): Router {
  const router = Router();
  const handler: RequestHandler = (_req: Request, res: Response) => {
    res.status(200).json(buildHealthReport());
  };

  for (const path of HEALTH_PATHS) {
    router.get(path, handler);
  }
  return router;
}
