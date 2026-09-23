import { readFileSync } from 'node:fs';
import { Router, type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_MESSAGES, loginSchema } from '@/shared';
import { createApp } from '../src/app.js';
import { disconnect } from '../src/db/connect.js';
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from './helpers/test-db.js';

/**
 * The runtime contract of the API floor: health, and the single failure shape
 * every other route will inherit (R010, R059).
 *
 * The suite is ordered deliberately. It proves health against a live database
 * first, then the failure shape, then disconnects and proves health still answers
 * - the probe must survive exactly the situation it exists to report.
 */

const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

const BOOM_MESSAGE = 'kaboom: internal detail that must never be returned';

function routerWith(register: (router: Router) => void): Router {
  const router = Router();
  register(router);
  return router;
}

const boomApp: Express = createApp({
  routers: [
    routerWith((router) => {
      router.get('/api/boom', () => {
        throw new Error(BOOM_MESSAGE);
      });
    }),
  ],
});

const validationApp: Express = createApp({
  routers: [
    routerWith((router) => {
      router.post('/api/validate', (req, res) => {
        res.status(200).json(loginSchema.parse(req.body));
      });
    }),
  ],
});

let app: Express;

beforeAll(async () => {
  await startTestDatabase();
  await resetTestDatabase();
  app = createApp();
});

afterAll(async () => {
  await stopTestDatabase();
});

describe('GET /health with a live database', () => {
  it('reports ok with the connected database, uptime and version', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toMatchObject({ status: 'ok', database: 'connected', version: SERVER_VERSION });
    expect(typeof response.body.uptimeSeconds).toBe('number');
    expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('answers the same through the /api prefix the browser and rewrite use', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', database: 'connected' });
  });
});

describe('the failure shape', () => {
  it('answers an unknown route with 404 in the shared shape and no stack', async () => {
    const response = await request(app).get('/api/there-is-no-such-route');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: 'NOT_FOUND',
      message: expect.stringContaining('/api/there-is-no-such-route'),
    });
    expect(response.text).not.toMatch(/\n\s+at /);
    expect(response.text).not.toContain('.ts:');
  });

  it('turns an unexpected route error into INTERNAL with nothing leaked', async () => {
    const response = await request(boomApp).get('/api/boom');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ code: 'INTERNAL', message: ERROR_MESSAGES.INTERNAL });
    expect(response.text).not.toContain('kaboom');
    expect(response.text).not.toContain(BOOM_MESSAGE);
    expect(response.text).not.toMatch(/\bat \w/);
    expect(response.text).not.toContain('.ts:');
  });

  it('refuses a body that is not JSON with VALIDATION_FAILED rather than 500', async () => {
    const response = await request(app)
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send('{"email": ');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'The request body was not valid JSON.',
    });
    expect(response.text).not.toMatch(/\n\s+at /);
  });

  it('reports a Zod failure as VALIDATION_FAILED with field-level details', async () => {
    const response = await request(validationApp)
      .post('/api/validate')
      .send({ email: 'not-an-email' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.message).toBe(ERROR_MESSAGES.VALIDATION_FAILED);
    expect(response.body.details.fields).toContainEqual({
      path: 'email',
      message: 'Enter a valid email address.',
    });
    expect(response.body.details.fields).toContainEqual({
      path: 'password',
      message: 'Enter your password.',
    });
  });
});

describe('GET /health without a database connection', () => {
  beforeAll(async () => {
    await disconnect();
  });

  it('still answers 200, reporting the degradation instead of failing', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'degraded', database: 'disconnected' });
    expect(response.body.version).toBe(SERVER_VERSION);
  });
});
