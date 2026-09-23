import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectEnvProblems, formatEnvProblems, parseEnv } from '../src/config/env.js';

/**
 * Environment validation, including the start-up abort itself.
 *
 * The abort is proven by running the module the way the process runs it
 * (`node --import tsx src/config/env.ts`) with a deliberately incomplete
 * environment: exit code, the variable names in the report, and the absence of a
 * stack trace. `CLAIMDESK_DISABLE_DOTENV=1` keeps a developer's own `.env` from
 * masking the failure, so the test asserts about the code rather than about the
 * machine it happens to run on.
 */

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_VARIABLES = [
  'MONGODB_URI',
  'SESSION_SECRET',
  'SEED_ADMIN_EMAIL',
  'SEED_ADMIN_PASSWORD',
  'SEED_ADMIN_NAME',
];

const VALID_ENV: Record<string, string> = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/claimdesk',
  SESSION_SECRET: 'a-test-session-secret-with-at-least-32-characters',
  SEED_ADMIN_EMAIL: 'admin@claimdesk.test',
  SEED_ADMIN_PASSWORD: 'admin-password',
  SEED_ADMIN_NAME: 'Claim Desk Administrator',
};

interface BootOutcome {
  status: number;
  stdout: string;
  stderr: string;
}

function bootOutcome(overrides: Record<string, string | undefined>): BootOutcome {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAIMDESK_DISABLE_DOTENV: '1' };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', 'src/config/env.ts'], {
      cwd: SERVER_ROOT,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe('environment validation', () => {
  it('names every missing required variable in one report', () => {
    const problems = collectEnvProblems({});
    const variables = problems.map((problem) => problem.variable).sort();

    expect(variables).toEqual([...REQUIRED_VARIABLES].sort());
    for (const problem of problems) {
      expect(problem.problem.length).toBeGreaterThan(0);
    }
  });

  it('names malformed values with what is wrong and where', () => {
    const problems = collectEnvProblems({
      ...VALID_ENV,
      MONGODB_URI: 'https://example.com/not-mongo',
      SESSION_SECRET: 'too-short',
      SEED_ADMIN_EMAIL: 'not-an-email',
      PORT: 'not-a-port',
    });
    const variables = problems.map((problem) => problem.variable).sort();

    expect(variables).toEqual(['MONGODB_URI', 'PORT', 'SEED_ADMIN_EMAIL', 'SESSION_SECRET']);

    const report = formatEnvProblems(problems);
    expect(report).toContain('Claim Desk API cannot start');
    for (const variable of variables) {
      expect(report).toContain(variable);
    }
    expect(report).not.toContain('ZodError');
    expect(report).not.toMatch(/\n\s+at /);
  });

  it('defaults the optional values and leaves later-slice credentials unset', () => {
    const result = parseEnv({ ...VALID_ENV, GOOGLE_CLIENT_ID: '', CLOUDINARY_URL: '' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.env.PORT).toBe(4000);
    expect(result.env.WEB_ORIGIN).toBe('http://localhost:3000');
    expect(result.env.LOG_LEVEL).toBe('info');
    expect(result.env.NODE_ENV).toBe('development');
    expect(result.env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(result.env.CLOUDINARY_URL).toBeUndefined();
  });

  it('applies the mail, lockout and rate-limit defaults when nothing is configured', () => {
    const result = parseEnv({ ...VALID_ENV });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Mail: an outbox-less development box still has a From header and smtp mode.
    expect(result.env.MAIL_FROM).toBe('Claim Desk <no-reply@claimdesk.local>');
    expect(result.env.MAIL_TRANSPORT).toBe('smtp');
    expect(result.env.MAIL_OUTBOX_DIR).toBeUndefined();
    expect(result.env.SMTP_URL).toBeUndefined();
    // Brute-force defences and the reset link lifetime.
    expect(result.env.AUTH_LOCKOUT_THRESHOLD).toBe(6);
    expect(result.env.AUTH_LOCKOUT_MINUTES).toBe(15);
    expect(result.env.AUTH_LOGIN_RATE_MAX).toBe(30);
    expect(result.env.AUTH_LOGIN_RATE_WINDOW_MINUTES).toBe(15);
    expect(result.env.AUTH_FORGOT_RATE_MAX).toBe(10);
    expect(result.env.AUTH_FORGOT_RATE_WINDOW_MINUTES).toBe(60);
    expect(result.env.RESET_TOKEN_MINUTES).toBe(60);
    expect(result.env.TRUST_PROXY).toBe('1');
  });

  it('refuses a lockout threshold below one rather than disabling the defence', () => {
    const result = parseEnv({ ...VALID_ENV, AUTH_LOCKOUT_THRESHOLD: '0' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const problems = collectEnvProblems({ ...VALID_ENV, AUTH_LOCKOUT_THRESHOLD: '0' });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.variable).toBe('AUTH_LOCKOUT_THRESHOLD');
  });

  it('refuses a production environment that cannot send mail, naming SMTP_URL alone', () => {
    const source = { ...VALID_ENV, NODE_ENV: 'production' };
    const problems = collectEnvProblems(source);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.variable).toBe('SMTP_URL');
    expect(problems[0]?.problem).toContain('required in production');

    const report = formatEnvProblems(problems);
    expect(report).toContain('1 environment variable needs attention');
    expect(report).toContain('SMTP_URL');

    // The same environment really does abort the process, not just fail a parse.
    const outcome = bootOutcome({ ...VALID_ENV, NODE_ENV: 'production', SMTP_URL: undefined });
    expect(outcome.status).not.toBe(0);
    expect(outcome.stderr).toContain('SMTP_URL');
    expect(outcome.stderr).toContain('required in production');
  });

  it('parses a production environment once SMTP_URL is set, and still needs no Google credentials', () => {
    const result = parseEnv({
      ...VALID_ENV,
      NODE_ENV: 'production',
      SMTP_URL: 'smtp://mail.claimdesk.test:587',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.env.NODE_ENV).toBe('production');
    expect(result.env.SMTP_URL).toBe('smtp://mail.claimdesk.test:587');
    expect(result.env.GOOGLE_CLIENT_ID).toBeUndefined();
  });

  it('accepts the outbox transport and its directory in development', () => {
    const result = parseEnv({
      ...VALID_ENV,
      MAIL_TRANSPORT: 'outbox',
      MAIL_OUTBOX_DIR: './mail-outbox',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.env.MAIL_TRANSPORT).toBe('outbox');
    expect(result.env.MAIL_OUTBOX_DIR).toBe('./mail-outbox');
  });

  it('refuses a mail transport that is not one of the two implemented modes', () => {
    const problems = collectEnvProblems({ ...VALID_ENV, MAIL_TRANSPORT: 'sendmail' });

    expect(problems).toHaveLength(1);
    expect(problems[0]?.variable).toBe('MAIL_TRANSPORT');
  });

  it('coerces a numeric PORT and lowercases the administrator email', () => {
    const result = parseEnv({ ...VALID_ENV, PORT: '4100', SEED_ADMIN_EMAIL: 'Admin@ClaimDesk.Test' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.env.PORT).toBe(4100);
    expect(result.env.SEED_ADMIN_EMAIL).toBe('admin@claimdesk.test');
  });

  it('aborts start-up non-zero, naming the variables, with no stack trace', () => {
    const outcome = bootOutcome({
      MONGODB_URI: undefined,
      SESSION_SECRET: undefined,
      SEED_ADMIN_EMAIL: undefined,
      SEED_ADMIN_PASSWORD: undefined,
      SEED_ADMIN_NAME: undefined,
    });

    expect(outcome.status).not.toBe(0);
    expect(outcome.stderr).toContain('Claim Desk API cannot start');
    for (const variable of REQUIRED_VARIABLES) {
      expect(outcome.stderr).toContain(variable);
    }
    expect(outcome.stderr).toContain('is required');
    expect(outcome.stderr).not.toContain('ZodError');
    expect(outcome.stderr).not.toMatch(/\n\s+at /);
    expect(outcome.stderr).not.toContain('node:internal');
  });

  it('starts cleanly when the environment is complete', () => {
    const outcome = bootOutcome(VALID_ENV);

    expect(outcome.status).toBe(0);
    expect(outcome.stderr).toBe('');
  });
});
