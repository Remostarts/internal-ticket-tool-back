import { Router, type Request, type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  clientKey,
  createRateLimit,
  createRateLimiter,
  resetRateLimits,
  trustProxyEnabled,
} from '../src/middleware/rate-limit.js';

/**
 * The rate limiter (R015).
 *
 * The limiter is exercised through the real application factory - the same
 * middleware stack a request meets in production, including the shared failure
 * handler - so these cases prove the refusal shape (`code`, `details`,
 * `Retry-After`) as well as the counting. The clock is injected everywhere, so
 * no case waits for a real window to pass.
 */

const START = 1_700_000_000_000;
const CLIENT = '203.0.113.7';

/** An app with one limited route, built the way the API builds itself. */
function appWith(handler: RequestHandler) {
  const router = Router();
  router.get('/api/test/limited', handler, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return createApp({ routers: [router] });
}

/** One request through the limited route, from a chosen forwarded address. */
function hit(app: ReturnType<typeof appWith>, forwardedFor?: string) {
  const call = request(app).get('/api/test/limited');
  return forwardedFor === undefined ? call : call.set('x-forwarded-for', forwardedFor);
}

/** A request object as far as `clientKey` is concerned, so no socket is needed. */
function fakeRequest(headers: Record<string, unknown>, remoteAddress?: string): Request {
  return { headers, socket: { remoteAddress } } as unknown as Request;
}

describe('a limiter over the real middleware stack', () => {
  it('allows the maximum, refuses the next request, and says how long to wait', async () => {
    let now = START;
    const limiter = createRateLimit({
      name: 'test-window',
      windowMs: 1_000,
      max: 3,
      now: () => now,
      trustProxy: true,
    });
    const app = appWith(limiter.handler);

    for (let i = 0; i < 3; i += 1) {
      const allowed = await hit(app, CLIENT);
      expect(allowed.status).toBe(200);
    }

    const refused = await hit(app, CLIENT);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(refused.body.message).toEqual(expect.any(String));
    expect(refused.body.message.length).toBeGreaterThan(0);
    expect(refused.body.details.retryAfterSeconds).toBe(1);
    expect(refused.headers['retry-after']).toBe(String(refused.body.details.retryAfterSeconds));
    expect(refused.body.details.limit).toBe('test-window');
  });

  it('lets the same caller in again once the window has passed', async () => {
    let now = START;
    const limiter = createRateLimit({
      name: 'test-expiry',
      windowMs: 1_000,
      max: 2,
      now: () => now,
      trustProxy: true,
    });
    const app = appWith(limiter.handler);

    expect((await hit(app, CLIENT)).status).toBe(200);
    expect((await hit(app, CLIENT)).status).toBe(200);
    expect((await hit(app, CLIENT)).status).toBe(429);

    now = START + 1_001;

    expect((await hit(app, CLIENT)).status).toBe(200);
  });

  it('does not let a refused request push its own window forward', async () => {
    let now = START;
    const limiter = createRateLimit({
      name: 'test-no-extension',
      windowMs: 1_000,
      max: 1,
      now: () => now,
      trustProxy: true,
    });
    const app = appWith(limiter.handler);

    expect((await hit(app, CLIENT)).status).toBe(200);
    now = START + 900;
    expect((await hit(app, CLIENT)).status).toBe(429);

    // 1_001ms after the single recorded hit - not after the refusal.
    now = START + 1_001;
    expect((await hit(app, CLIENT)).status).toBe(200);
  });

  it('counts two forwarded addresses separately', async () => {
    let now = START;
    const limiter = createRateLimit({
      name: 'test-keys',
      windowMs: 1_000,
      max: 3,
      now: () => now,
      trustProxy: true,
    });
    const app = appWith(limiter.handler);

    expect((await hit(app, '198.51.100.1')).status).toBe(200);
    expect((await hit(app, '198.51.100.1')).status).toBe(200);
    expect((await hit(app, '198.51.100.2')).status).toBe(200);
    expect((await hit(app, '198.51.100.2')).status).toBe(200);
    // Three each is still inside both windows.
    expect((await hit(app, '198.51.100.1')).status).toBe(200);
    expect((await hit(app, '198.51.100.2')).status).toBe(200);
    // The fourth for the first address is refused, while the second is spent.
    expect((await hit(app, '198.51.100.1')).status).toBe(429);
  });

  it('ignores the forwarded header entirely when TRUST_PROXY is off', async () => {
    const saved = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = '0';
    try {
      expect(trustProxyEnabled()).toBe(false);

      let now = START;
      const limiter = createRateLimit({
        name: 'test-no-proxy',
        windowMs: 1_000,
        max: 2,
        now: () => now,
      });
      const app = appWith(limiter.handler);

      expect((await hit(app, '198.51.100.1')).status).toBe(200);
      // A different forwarded address is the same socket address underneath, so
      // this is the second hit rather than a fresh window.
      expect((await hit(app, '198.51.100.2')).status).toBe(200);
      expect((await hit(app, '198.51.100.3')).status).toBe(429);
    } finally {
      if (saved === undefined) {
        delete process.env.TRUST_PROXY;
      } else {
        process.env.TRUST_PROXY = saved;
      }
    }
  });

  it('is emptied by the reset hook, so a suite can start from a clean window', async () => {
    let now = START;
    const limiter = createRateLimit({
      name: 'test-reset',
      windowMs: 60_000,
      max: 1,
      now: () => now,
      trustProxy: true,
    });
    const app = appWith(limiter.handler);

    expect((await hit(app, CLIENT)).status).toBe(200);
    expect((await hit(app, CLIENT)).status).toBe(429);

    resetRateLimits();

    expect((await hit(app, CLIENT)).status).toBe(200);
  });

  it('refuses a window or a maximum that would silently change the endpoint', () => {
    const base = { name: 'broken', windowMs: 1_000, max: 1 };

    expect(() => createRateLimit({ ...base, max: 0 })).toThrow(RangeError);
    expect(() => createRateLimit({ ...base, max: 1.5 })).toThrow(RangeError);
    expect(() => createRateLimit({ ...base, windowMs: 0 })).toThrow(RangeError);
    expect(() => createRateLimit({ ...base, windowMs: Number.NaN })).toThrow(RangeError);
    expect(() => createRateLimit({ ...base, name: '  ' })).toThrow(RangeError);
  });

  it('exposes the handler on its own for a call site that needs no test hook', async () => {
    const handler = createRateLimiter({
      name: 'test-handler',
      windowMs: 1_000,
      max: 1,
      now: () => START,
      trustProxy: true,
    });
    const app = appWith(handler);

    expect((await hit(app, CLIENT)).status).toBe(200);
    expect((await hit(app, CLIENT)).status).toBe(429);
  });
});

describe('choosing the key a caller is counted under', () => {
  it('takes the first hop of the forwarded header when the proxy is trusted', () => {
    expect(clientKey(fakeRequest({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, '9.9.9.9'), true)).toBe(
      '1.2.3.4',
    );
    expect(clientKey(fakeRequest({ 'x-forwarded-for': '1.2.3.4' }, '9.9.9.9'), true)).toBe('1.2.3.4');
  });

  it('falls back to the socket address when the proxy is not trusted', () => {
    expect(clientKey(fakeRequest({ 'x-forwarded-for': '1.2.3.4' }, '9.9.9.9'), false)).toBe(
      '9.9.9.9',
    );
  });

  it('never throws on an absent, empty, oversized or wrong-typed header', () => {
    const cases: Record<string, unknown>[] = [
      {},
      { 'x-forwarded-for': undefined },
      { 'x-forwarded-for': '' },
      { 'x-forwarded-for': '   ,  ' },
      { 'x-forwarded-for': 'x'.repeat(200) },
      { 'x-forwarded-for': 42 },
      { 'x-forwarded-for': null },
      { 'x-forwarded-for': { host: '1.2.3.4' } },
    ];

    for (const headers of cases) {
      expect(() => clientKey(fakeRequest(headers, '9.9.9.9'), true)).not.toThrow();
      expect(clientKey(fakeRequest(headers, '9.9.9.9'), true)).toBe('9.9.9.9');
    }
  });

  it('joins repeated headers and takes the first hop', () => {
    expect(
      clientKey(fakeRequest({ 'x-forwarded-for': ['1.2.3.4', '5.6.7.8'] }, '9.9.9.9'), true),
    ).toBe('1.2.3.4');
  });

  it('names an unknown socket rather than returning nothing', () => {
    expect(clientKey(fakeRequest({}, undefined), true)).toBe('unknown');
  });
});
