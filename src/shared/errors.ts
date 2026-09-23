/**
 * The single API failure shape.
 *
 * Every failure the API returns - validation, authentication, permission,
 * not-found, rate limit, unexpected - is `{ code, message, details? }` with a
 * real HTTP status. The web app switches on `code` to render plain language
 * rather than showing a payload to a user.
 */

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'INVALID_CREDENTIALS',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'RATE_LIMITED',
  'MAIL_NOT_CONFIGURED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The status each code is carried by, so status and code can never disagree. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  INVALID_CREDENTIALS: 401,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  MAIL_NOT_CONFIGURED: 503,
  INTERNAL: 500,
};

/** Default human-readable message per code. Specific cases may override it. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHENTICATED: 'Your session has ended. Sign in again to continue.',
  PERMISSION_DENIED: 'Your role does not allow this action.',
  INVALID_CREDENTIALS: 'That email and password combination was not recognised.',
  VALIDATION_FAILED: 'Some of the submitted values need correcting.',
  NOT_FOUND: 'That record does not exist.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  MAIL_NOT_CONFIGURED:
    'Password reset is not available on this installation. Ask an administrator to reset your password.',
  INTERNAL: 'Something went wrong on our side. Try again shortly.',
};

/** Extra data a refusal carries. `requiredPermission` drives the denial panel. */
export interface ApiErrorDetails {
  requiredPermission?: string;
  role?: string;
  fields?: Array<{ path: string; message: string }>;
  [key: string]: unknown;
}

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: ApiErrorDetails;
}

const ERROR_CODE_SET = new Set<string>(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}

/** Narrows an unknown body to the shared failure shape. */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { code?: unknown; message?: unknown };
  return isErrorCode(candidate.code) && typeof candidate.message === 'string';
}

/** The status that belongs to a code, defaulting to 500 for anything unknown. */
export function httpStatusForCode(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code] ?? ERROR_HTTP_STATUS.INTERNAL;
}
