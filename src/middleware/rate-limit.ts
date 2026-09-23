import type { Request, RequestHandler } from 'express';
import { env } from '../config/env.js';
import { logger } from '../logging/logger.js';
import { AppError } from './error-handler.js';

/**
 * The unauthenticated-endpoint rate limiter (R015).
 *
 * Sign-in and password-recovery are the only surfaces a stranger can reach, and
 * both can be abused: one to guess a password, the other to send mail through
 * this installation. This is the cheap, first-line defence - a sliding window
 * per client address - and it deliberately has no database access, so it cannot
 * add load to the thing it is protecting and cannot fail when the database does.
 *
 * A **sliding window** rather than a fixed bucket: a request is refused when
 * the number of *recorded* hits newer than `windowMs` has reached `max`, so a
 * caller cannot double their allowance by straddling a bucket boundary. The
 * timestamp list is pruned on every hit, and a fully-stale entry is dropped
 * during a sweep (at most once per window, or sooner when the map has grown
 * past `SWEEP_SIZE_THRESHOLD`), which is what keeps a long-running process from
 * accumulating one entry per address it has ever seen.
 *
 * A refusal leaves through the shared failure shape - `next(new AppError(
 * 'RATE_LIMITED', ...))` with `details.retryAfterSeconds` - *and* sets the
 * `Retry-After` header, so the machine-readable hint and the human-facing body
 * always agree. The refused request is not recorded: a flood must not keep
 * pushing its own window forward.
 *
 * **The store is per process.** Two API instances behind a load balancer each
 * get their own window, so the effective limit multiplies by the instance
 * count. That is a deliberate limitation of this slice; M008's deployment work
 * owns the shared store (the seam is `createRateLimit`, which already isolates
 * the decision from the storage).
 */

/** Stops the map from growing without bound inside a single window. */
const SWEEP_SIZE_THRESHOLD = 10_000;

/** Keys longer than this are treated as malformed rather than stored. */
const MAX_KEY_LENGTH = 64;

export interface RateLimitOptions {
  /** The limiter's name, carried in the refusal details and in logs. */
  name: string;
  windowMs: number;
  max: number;
  /** Injected clock (milliseconds), so a test never waits for a real window. */
  now?: () => number;
  /**
   * Whether to trust the first hop of `x-forwarded-for`. Defaults to
   * `TRUST_PROXY`; a deployment behind no proxy must leave that off, or a
   * caller can pick their own window by sending the header.
   */
  trustProxy?: boolean;
}

export interface RateLimiter {
  readonly name: string;
  readonly handler: RequestHandler;
  /** Forgets every recorded hit, so a test starts from a clean window. */
  readonly reset: () => void;
}

/** Every store created in this process, so `resetRateLimits` can clear them all. */
const stores = new Set<Map<string, number[]>>();

/**
 * A test hook: empties every window created by `createRateLimit` so far. It has
 * no production call site - a live process must never clear its own limits.
 */
export function resetRateLimits(): void {
  for (const store of stores) {
    store.clear();
  }
}

/** Whether `TRUST_PROXY` asks the limiter to believe the forwarded header. */
export function trustProxyEnabled(): boolean {
  // Read at call time (falling back to the validated value) so a test can flip
  // it; in a real process the two are the same string.
  const raw = (process.env.TRUST_PROXY ?? env.TRUST_PROXY ?? '').trim().toLowerCase();
  return raw !== '' && raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

/** The first hop of `x-forwarded-for`, or null when it is absent or unusable. */
function firstForwardedHop(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (typeof raw !== 'string') {
    return null;
  }
  const first = (raw.split(',')[0] ?? '').trim();
  if (first.length === 0 || first.length > MAX_KEY_LENGTH) {
    return null;
  }
  return first;
}

/**
 * The key one caller's hits are counted under.
 *
 * With `TRUST_PROXY` on, the first hop of `x-forwarded-for` is the client as the
 * proxy saw it; otherwise the socket address is the only thing a caller cannot
 * invent. A missing or malformed header falls back to the socket rather than
 * throwing, so a hostile header cannot break the limiter it is aimed at.
 */
export function clientKey(req: Request, trustProxy: boolean = trustProxyEnabled()): string {
  if (trustProxy) {
    const forwarded = firstForwardedHop(req.headers['x-forwarded-for']);
    if (forwarded) {
      return forwarded;
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

function assertPositiveInteger(value: number, what: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`Rate limit ${what} must be a whole number of at least 1, got ${value}.`);
  }
}

/**
 * Builds a limiter and hands back both its handler and a `reset` for tests.
 *
 * Construction fails loudly on a nonsensical window or maximum: a limiter with
 * `max: 0` would refuse every request, and a window of zero would refuse none -
 * both are configuration mistakes that should stop a process rather than
 * quietly change what the endpoint does.
 */
export function createRateLimit(options: RateLimitOptions): RateLimiter {
  const { name, windowMs, max } = options;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new RangeError('Rate limit name must be a non-empty string.');
  }
  assertPositiveInteger(windowMs, 'windowMs');
  assertPositiveInteger(max, 'max');

  const clock = options.now ?? (() => Date.now());
  const useTrustProxy = options.trustProxy ?? trustProxyEnabled();
  const store = new Map<string, number[]>();
  stores.add(store);
  let lastSweepAt = clock();

  const reset = (): void => {
    store.clear();
  };

  /** Drops timestamps that have left the window. Never mutates the input. */
  const prune = (hits: number[], cutoff: number): number[] =>
    hits.filter((timestamp) => timestamp > cutoff);

  const sweep = (cutoff: number): void => {
    for (const [key, hits] of store) {
      const recent = prune(hits, cutoff);
      if (recent.length === 0) {
        store.delete(key);
      } else {
        store.set(key, recent);
      }
    }
  };

  const handler: RequestHandler = (req, res, next) => {
    const at = clock();
    const cutoff = at - windowMs;
    const key = clientKey(req, useTrustProxy);
    const hits = prune(store.get(key) ?? [], cutoff);

    if (hits.length >= max) {
      const oldest = hits[0] ?? at;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - at) / 1000));
      // Keep the pruned list so the window still expires at the right moment.
      store.set(key, hits);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      logger.debug({ limiter: name, retryAfterSeconds }, 'rate limit refused');
      next(
        new AppError('RATE_LIMITED', undefined, {
          retryAfterSeconds,
          limit: name,
        }),
      );
      return;
    }

    hits.push(at);
    store.set(key, hits);

    if (at - lastSweepAt >= windowMs || store.size > SWEEP_SIZE_THRESHOLD) {
      lastSweepAt = at;
      sweep(cutoff);
    }

    next();
  };

  return { name, handler, reset };
}

/** The handler on its own, for a call site that does not need the test hook. */
export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  return createRateLimit(options).handler;
}
