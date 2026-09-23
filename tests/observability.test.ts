import { Writable } from 'node:stream';
import express, { Router, type Request } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { createLogger, REDACTION_CENSOR } from '../src/logging/logger.js';
import { createRequestLogger } from '../src/middleware/request-logger.js';

/**
 * Structured logs and their redaction (R010 and the slice's redaction
 * constraint).
 *
 * The logger and the request-logger middleware are exercised exactly as the API
 * mounts them (`createRequestLogger` is the same factory `createApp` uses),
 * writing to a captured stream instead of stdout so each line can be asserted as
 * JSON rather than as a substring of console noise.
 */

interface CapturedLogs {
  log: Logger;
  lines: () => Array<Record<string, unknown>>;
  raw: () => string;
}

function captureLogs(): CapturedLogs {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });

  return {
    log: createLogger({ level: 'trace', destination: stream }),
    raw: () => chunks.join(''),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const SECRETS = [
  'password-should-never-appear',
  '$2b$12$hash-should-never-appear',
  'token-should-never-appear',
  'cd_session=cookie-should-never-appear',
  'Bearer authorization-should-never-appear',
  'nested-token-should-never-appear',
  'header-cookie-should-never-appear',
  'header-authorization-should-never-appear',
];

describe('the structured logger', () => {
  it('writes one JSON object per line', () => {
    const capture = captureLogs();
    capture.log.info({ port: 4000 }, 'api listening');

    const lines = capture.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 30, msg: 'api listening', port: 4000 });
    expect(typeof lines[0]?.time).toBe('string');
  });

  it('censors every secret field in the redaction list, at the top level and nested', () => {
    const capture = captureLogs();
    capture.log.info(
      {
        password: SECRETS[0],
        passwordHash: SECRETS[1],
        token: SECRETS[2],
        cookie: SECRETS[3],
        authorization: SECRETS[4],
        nested: { token: SECRETS[5] },
        headers: { cookie: SECRETS[6], authorization: SECRETS[7] },
        email: 'person@claimdesk.test',
      },
      'sign-in attempt',
    );

    const raw = capture.raw();
    for (const secret of SECRETS) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain(REDACTION_CENSOR);
    // The rest of the record survives: redaction must not blank the line.
    expect(raw).toContain('person@claimdesk.test');

    const line = capture.lines()[0];
    expect(line).toMatchObject({
      password: REDACTION_CENSOR,
      passwordHash: REDACTION_CENSOR,
      token: REDACTION_CENSOR,
      cookie: REDACTION_CENSOR,
      authorization: REDACTION_CENSOR,
      nested: { token: REDACTION_CENSOR },
    });
  });
});

describe('the request logger', () => {
  function appWithRouter(register: (router: Router) => void): express.Express {
    const router = Router();
    register(router);
    const app = express();
    app.use(createRequestLogger(lastLog.log));
    app.use(router);
    return app;
  }

  const lastLog = captureLogs();

  it('records method, path, status, duration and the resolved user id', async () => {
    const app = appWithRouter((router) => {
      router.get('/api/widgets', (req, res) => {
        (req as Request & { user?: unknown }).user = { id: 'user-42', role: 'manager' };
        res.status(201).json({ ok: true });
      });
    });

    await request(app).get('/api/widgets').expect(201);

    const lines = lastLog.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      msg: 'request',
      method: 'GET',
      path: '/api/widgets',
      status: 201,
      userId: 'user-42',
    });
    expect(typeof lines[0]?.durationMs).toBe('number');
    expect(lines[0]?.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it('keeps a token in the query string out of the log', async () => {
    const app = appWithRouter((router) => {
      router.get('/api/reset', (_req, res) => {
        res.status(200).json({ ok: true });
      });
    });

    await request(app).get('/api/reset?token=single-use-reset-token').expect(200);

    const lines = lastLog.lines();
    expect(lines.at(-1)).toMatchObject({ path: '/api/reset' });
    expect(lastLog.raw()).not.toContain('single-use-reset-token');
  });

  it('records a signed-out request with a null user id', async () => {
    const app = appWithRouter((router) => {
      router.get('/api/anonymous', (_req, res) => {
        res.status(200).json({ ok: true });
      });
    });

    await request(app).get('/api/anonymous').expect(200);

    expect(lastLog.lines().at(-1)).toMatchObject({
      path: '/api/anonymous',
      status: 200,
      userId: null,
    });
  });

  it('logs the refusal of an unmatched route once, through the failure handler', async () => {
    const app = appWithRouter(() => {
      // no routes: everything falls through to Express's own 404
    });

    await request(app).get('/api/nothing-here').expect(404);

    const requestLines = lastLog
      .lines()
      .filter((line) => line.msg === 'request' && line.path === '/api/nothing-here');
    expect(requestLines).toHaveLength(1);
    expect(requestLines[0]).toMatchObject({ path: '/api/nothing-here', status: 404 });
  });
});
