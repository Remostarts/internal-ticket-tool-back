import type { Request, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { isRole, type Role } from '@/shared';
import { logger as appLogger } from '../logging/logger.js';

/**
 * The per-request structured log (R010).
 *
 * One line per request, carrying method, path, status, duration and the resolved
 * user id. Everything a diagnosis needs to reconstruct a request without a
 * debugger.
 *
 * The query string is deliberately not logged: a single-use token
 * (`?token=...` on a password-reset link) lives there, and redaction works on
 * field names, so a whole URL cannot be censored by path. `requestPath` is
 * exported so the audit writer in a refusal records the same value.
 */

export interface RequestUser {
  id: string;
  role: Role;
}

/**
 * Reads the user attached by `require-auth` (T03). Declared here rather than by
 * augmenting Express's global namespace so this slice does not fix the shape a
 * later slice needs to attach; anything unrecognised is treated as signed out.
 */
export function getRequestUser(req: Request): RequestUser | null {
  const candidate = (req as Request & { user?: { id?: unknown; role?: unknown } }).user;
  if (!candidate || typeof candidate.id !== 'string' || !isRole(candidate.role)) {
    return null;
  }
  return { id: candidate.id, role: candidate.role };
}

/** The path without its query string, which may carry a token. */
export function requestPath(req: Request): string {
  return req.originalUrl.split('?')[0] ?? req.path;
}

export function createRequestLogger(log: Logger = appLogger): RequestHandler {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    let logged = false;

    const writeLine = (): void => {
      if (logged) {
        return; // `close` follows `finish` on a normal response; log once.
      }
      logged = true;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      log.info(
        {
          method: req.method,
          path: requestPath(req),
          status: res.statusCode,
          durationMs: Math.round(durationMs * 10) / 10,
          userId: getRequestUser(req)?.id ?? null,
        },
        'request',
      );
    };

    res.on('finish', writeLine);
    res.on('close', writeLine);
    next();
  };
}
