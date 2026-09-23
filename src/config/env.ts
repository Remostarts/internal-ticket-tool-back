import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenvFile } from 'dotenv';
import { z } from 'zod';
import { LOG_LEVELS } from '../logging/logger.js';

/**
 * Environment validation.
 *
 * The API reads its configuration exactly once, when this module is imported.
 * Every problem is collected first and reported together, so one start-up
 * attempt tells an operator everything that needs fixing. The process then exits
 * non-zero with a plain list of variable names and what is wrong with each - no
 * Zod dump, no stack trace, and no silent default for a required value.
 *
 * The variables the later slices need (Cloudinary uploads) are deliberately
 * optional here: "not configured yet" and "configured wrongly" must stay
 * distinguishable. Password recovery is the exception that proves the rule -
 * mail is optional until the deployment is production, where a missing
 * `SMTP_URL` is a start-up failure rather than a silent gap in recovery.
 */

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const requiredText = (what: string) =>
  z.string({ required_error: `is required (${what})` }).trim().min(1, 'is required');

const optionalText = z.preprocess(blankToUndefined, z.string().trim().optional());

/** An optional whole number that falls back to a documented default when unset. */
const optionalInt = (fallback: number, minimum: number) =>
  z.preprocess(
    blankToUndefined,
    z.coerce
      .number({ invalid_type_error: 'must be a number' })
      .int('must be a whole number')
      .min(minimum, `must be ${minimum} or more`)
      .default(fallback),
  );

const httpUrl = (what: string) => z.string().trim().url(`must be a valid ${what} URL`);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // Required from this slice onwards.
    MONGODB_URI: requiredText('a MongoDB connection string').refine(
      (value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'),
      'must start with mongodb:// or mongodb+srv://',
    ),
    SESSION_SECRET: z
      .string({ required_error: 'is required (the session cookie signing secret)' })
      .trim()
      .min(32, 'must be at least 32 characters long'),
    SEED_ADMIN_EMAIL: z.preprocess(
      blankToUndefined,
      z.string().trim().toLowerCase().email('must be a valid email address').optional()
    ),
    SEED_ADMIN_PASSWORD: z.preprocess(
      blankToUndefined,
      z.string().min(8, 'must be at least 8 characters long').optional()
    ),
    SEED_ADMIN_NAME: optionalText,

    // Optional, with defaults.
    PORT: z.preprocess(
      blankToUndefined,
      z.coerce
        .number({ invalid_type_error: 'must be a number' })
        .int('must be a whole number')
        .min(1, 'must be between 1 and 65535')
        .max(65535, 'must be between 1 and 65535')
        .default(4000),
    ),
    WEB_ORIGIN: z.preprocess(
      blankToUndefined,
      httpUrl('web origin').default('http://localhost:3000'),
    ),
    API_ORIGIN: z.preprocess(
      blankToUndefined,
      httpUrl('API origin').default('http://127.0.0.1:4000'),
    ),
    LOG_LEVEL: z.preprocess(blankToUndefined, z.enum(LOG_LEVELS).default('info')),
    MONGODB_URI_TEST: optionalText,

    // S02: the credential paths and the brute-force defences (R013-R015).
    GOOGLE_CLIENT_ID: optionalText,
    GOOGLE_CLIENT_SECRET: optionalText,
    /**
     * The exact callback registered in the Google console. Optional because a
     * single-process development run can derive it from `API_ORIGIN`; a
     * deployment that reaches the API through the web origin sets it, because
     * Google will only return to a URL it knows about.
     */
    GOOGLE_REDIRECT_URI: optionalText,
    SMTP_URL: optionalText,
    MAIL_FROM: z.preprocess(
      blankToUndefined,
      z.string().trim().default('Claim Desk <no-reply@claimdesk.local>'),
    ),
    /**
     * How a message leaves the API. `outbox` writes it to a file instead of
     * sending it, which is what a developer without an SMTP server uses;
     * production refuses it (see the cross-field rule below).
     */
    MAIL_TRANSPORT: z.preprocess(blankToUndefined, z.enum(['smtp', 'outbox']).default('smtp')),
    MAIL_OUTBOX_DIR: optionalText,
    /** Consecutive failures that lock an account, and how long the lock lasts. */
    AUTH_LOCKOUT_THRESHOLD: optionalInt(6, 1),
    AUTH_LOCKOUT_MINUTES: optionalInt(15, 1),
    /** Requests one address may make to the unauthenticated sign-in endpoints. */
    AUTH_LOGIN_RATE_MAX: optionalInt(30, 1),
    AUTH_LOGIN_RATE_WINDOW_MINUTES: optionalInt(15, 1),
    AUTH_FORGOT_RATE_MAX: optionalInt(10, 1),
    AUTH_FORGOT_RATE_WINDOW_MINUTES: optionalInt(60, 1),
    /** Express `trust proxy` value; the rate limiter keys on the client address. */
    TRUST_PROXY: z.preprocess(blankToUndefined, z.string().trim().default('1')),
    /** How long a password-reset link stays usable. */
    RESET_TOKEN_MINUTES: optionalInt(60, 1),

    // S04: uploads.
    CLOUDINARY_URL: optionalText,
  })
  /**
   * The one cross-field rule: a production deployment that cannot send mail has
   * no way to deliver a reset link, so it is refused at start-up rather than
   * accepted and only discovered by the first locked-out operator. Development
   * and test may keep SMTP unset - the outbox transport covers them.
   */
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === 'production' && !value.SMTP_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_URL'],
        message: 'is required in production: password reset has no other delivery path',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface EnvProblem {
  variable: string;
  problem: string;
}

/**
 * `.env` support: the documented workflow is `cp .env.example .env`, so a
 * checked-out repository starts without exporting anything by hand. Real
 * environment variables always win (`override: false`), and `CLAIMDESK_DISABLE_DOTENV=1`
 * skips file loading entirely for deployments that inject configuration
 * directly and for tests that assert on a deliberately broken environment.
 */
function loadEnvFiles(): void {
  if (process.env.CLAIMDESK_DISABLE_DOTENV === '1') {
    return;
  }
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')];
  for (const file of candidates) {
    if (existsSync(file)) {
      loadDotenvFile({ path: file, override: false, quiet: true });
    }
  }
}

/** One entry per offending variable - the first problem found for each. */
export function collectEnvProblems(source: NodeJS.ProcessEnv = process.env): EnvProblem[] {
  const result = envSchema.safeParse(source);
  if (result.success) {
    return [];
  }
  const problems = new Map<string, string>();
  for (const issue of result.error.issues) {
    const variable = issue.path.join('.') || '(environment)';
    if (!problems.has(variable)) {
      problems.set(variable, issue.message);
    }
  }
  return [...problems].map(([variable, problem]) => ({ variable, problem }));
}

/** The operator-facing report. Variable names and what is wrong, nothing else. */
export function formatEnvProblems(problems: EnvProblem[]): string {
  const headline =
    problems.length === 1
      ? 'Claim Desk API cannot start: 1 environment variable needs attention.'
      : `Claim Desk API cannot start: ${problems.length} environment variables need attention.`;
  return [
    headline,
    ...problems.map((entry) => `  - ${entry.variable} ${entry.problem}`),
    '',
    'Set them in .env (copy .env.example) or in the process environment, then start again.',
  ].join('\n');
}

export type ParseEnvResult = { ok: true; env: Env } | { ok: false; problems: EnvProblem[] };

export function parseEnv(source: NodeJS.ProcessEnv = process.env): ParseEnvResult {
  const result = envSchema.safeParse(source);
  if (result.success) {
    return { ok: true, env: result.data };
  }
  return { ok: false, problems: collectEnvProblems(source) };
}

/** Parses or terminates the process. Never returns a partially valid environment. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = parseEnv(source);
  if (result.ok) {
    return Object.freeze(result.env);
  }
  process.stderr.write(`${formatEnvProblems(result.problems)}\n`);
  return process.exit(1);
}

loadEnvFiles();

/** The validated configuration. Importing this module is the only way to read it. */
export const env: Env = loadEnv();
