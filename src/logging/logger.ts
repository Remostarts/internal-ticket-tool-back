import pino, { type DestinationStream, type Logger, type LevelWithSilent } from 'pino';

/**
 * The one logger for the API.
 *
 * Every line is a JSON object, so a failure can be reconstructed from logs
 * rather than guessed at (R010). The redaction list is part of the contract:
 * a password, a password hash, a session token, a cookie or an Authorization
 * header must never reach a log sink, however carelessly a call site logs an
 * object (R011 redaction constraint in the slice plan).
 *
 * This module deliberately reads `process.env.LOG_LEVEL` itself instead of going
 * through `config/env.ts`, so the logger can be constructed even on the path
 * that rejects an unparseable environment - the crash report must not depend on
 * the configuration that just failed.
 */

/** Every level pino accepts, plus `silent`. `config/env.ts` validates against this list. */
export const LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
] as const;

export const DEFAULT_LOG_LEVEL: LevelWithSilent = 'info';

/**
 * Paths pino censors before a record is serialised. The bare names cover the
 * common `logger.info({ password })` mistake; the wildcards cover the same names
 * one level down (`{ body: { password } }`, `{ user: { token } }`).
 */
export const REDACTED_LOG_PATHS = [
  'password',
  'passwordHash',
  'token',
  'cookie',
  'authorization',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.cookie',
  '*.authorization',
  'headers.cookie',
  'headers.authorization',
  'req.headers.cookie',
  'req.headers.authorization',
] as const;

export const REDACTION_CENSOR = '[redacted]';

/** Falls back to `info` for an unset or unrecognised level rather than throwing. */
export function resolveLogLevel(raw: string | undefined = process.env.LOG_LEVEL): LevelWithSilent {
  const candidate = (raw ?? '').trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(candidate)
    ? (candidate as LevelWithSilent)
    : DEFAULT_LOG_LEVEL;
}

export interface CreateLoggerOptions {
  /** Overrides `LOG_LEVEL`; used by tests. */
  level?: string;
  /** Overrides stdout; used by tests to capture lines. */
  destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return pino(
    {
      name: 'claimdesk-api',
      level: resolveLogLevel(options.level),
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: [...REDACTED_LOG_PATHS], censor: REDACTION_CENSOR },
    },
    options.destination,
  );
}

/** The process-wide logger. Import this rather than creating another one. */
export const logger: Logger = createLogger();
