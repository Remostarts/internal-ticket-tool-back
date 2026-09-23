import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';
import {
  ERROR_MESSAGES,
  httpStatusForCode,
  type ApiErrorDetails,
  type ErrorCode,
} from '@/shared';
import { logger } from '../logging/logger.js';
import { requestPath } from './request-logger.js';

/**
 * The single failure shape for the whole API (R059).
 *
 * Every failure leaves as `{ code, message, details? }` carried by its real HTTP
 * status, so the web app can switch on `code` and render plain language instead
 * of showing a payload to a user. Two rules hold this together:
 *
 *   - a known failure (`AppError`, a Zod failure, unparseable JSON) keeps its
 *     code, status and message;
 *   - an unexpected failure becomes `INTERNAL` / 500 with a generic message. Its
 *     stack and its message are logged and never returned, so a production error
 *     body cannot become a map of the system.
 */

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: ApiErrorDetails;

  constructor(code: ErrorCode, message?: string, details?: ApiErrorDetails, options?: { cause?: unknown }) {
    super(message ?? ERROR_MESSAGES[code], options);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatusForCode(code);
    this.details = details;
  }
}

interface FieldDetail {
  path: string;
  message: string;
}

/** Accepts both a real `ZodError` and anything shaped like one across duplicate zod copies. */
function zodIssues(error: unknown): Array<{ path?: unknown; message?: unknown }> | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const candidate = error as { issues?: unknown; name?: unknown };
  if (!Array.isArray(candidate.issues)) {
    return null;
  }
  if (candidate.name === 'ZodError' || candidate.issues.every((issue) => typeof issue === 'object')) {
    return candidate.issues as Array<{ path?: unknown; message?: unknown }>;
  }
  return null;
}

function toFieldDetails(issues: Array<{ path?: unknown; message?: unknown }>): FieldDetail[] {
  return issues.map((issue) => {
    const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
    return {
      path: path || '(body)',
      message: typeof issue.message === 'string' ? issue.message : 'is not valid',
    };
  });
}

/** True for body-parser's "the request body is not JSON" failure. */
function isJsonParseFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { type?: unknown }).type === 'entity.parse.failed'
  );
}

interface NormalizedFailure {
  code: ErrorCode;
  httpStatus: number;
  message: string;
  details?: ApiErrorDetails;
  /** Whether this is an expected refusal (logged as a warning) or a real fault (logged as an error). */
  expected: boolean;
}

function normalizeFailure(error: unknown): NormalizedFailure {
  if (error instanceof AppError) {
    return {
      code: error.code,
      httpStatus: error.httpStatus,
      message: error.message,
      details: error.details,
      expected: true,
    };
  }

  const issues = zodIssues(error);
  if (issues) {
    return {
      code: 'VALIDATION_FAILED',
      httpStatus: httpStatusForCode('VALIDATION_FAILED'),
      message: ERROR_MESSAGES.VALIDATION_FAILED,
      details: { fields: toFieldDetails(issues) },
      expected: true,
    };
  }

  if (isJsonParseFailure(error)) {
    return {
      code: 'VALIDATION_FAILED',
      httpStatus: httpStatusForCode('VALIDATION_FAILED'),
      message: 'The request body was not valid JSON.',
      expected: true,
    };
  }

  // Catch MongoDB E11000 duplicate key error
  if (typeof error === 'object' && error !== null && (error as any).code === 11000) {
    const field = Object.keys((error as any).keyPattern || (error as any).keyValue || {})[0] || 'field';
    return {
      code: 'VALIDATION_FAILED',
      httpStatus: 409,
      message: `A record with this ${field} already exists.`,
      expected: true,
    };
  }

  // Honor custom error status codes (e.g. 409 Conflict)
  if (typeof error === 'object' && error !== null && ((error as any).statusCode || (error as any).httpStatus)) {
    const status = Number((error as any).statusCode || (error as any).httpStatus);
    if (!Number.isNaN(status) && status >= 400 && status < 500) {
      return {
        code: ((error as any).code as ErrorCode) || 'VALIDATION_FAILED',
        httpStatus: status,
        message: (error as any).message || ERROR_MESSAGES.VALIDATION_FAILED,
        expected: true,
      };
    }
  }

  return {
    code: 'INTERNAL',
    httpStatus: httpStatusForCode('INTERNAL'),
    message: ERROR_MESSAGES.INTERNAL,
    expected: false,
  };
}

/**
 * Wraps an async handler so a rejected promise reaches the failure handler.
 *
 * Express 4 only forwards a synchronous throw; an `await` that rejects inside a
 * route would otherwise become an unhandled rejection and the request would hang
 * until it timed out. Every async route in this codebase goes through here, so
 * "the failure shape is the only failure shape" holds for promises too.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (res.headersSent) {
    logger.error({ err: error, path: requestPath(req) }, 'failure after the response was sent');
    res.end();
    return;
  }

  const failure = normalizeFailure(error);
  const context = {
    method: req.method,
    path: requestPath(req),
    status: failure.httpStatus,
    code: failure.code,
  };

  if (failure.expected) {
    // A refusal is a normal outcome, but it still has to be visible: a spike in
    // 403s is a permission model problem, not noise.
    logger.warn(context, 'request refused');
  } else {
    logger.error({ ...context, err: error }, 'unexpected failure');
  }

  const body: { code: ErrorCode; message: string; details?: ApiErrorDetails } = {
    code: failure.code,
    message: failure.message,
  };
  if (failure.details) {
    body.details = failure.details;
  }

  res.status(failure.httpStatus).json(body);
};

/** Registered after every route, so an unmatched path fails in the same shape as everything else. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError('NOT_FOUND', `No API route matches ${req.method} ${requestPath(req)}.`));
};
