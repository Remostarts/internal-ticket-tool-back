import express, { type Express, type Router } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createRequestLogger } from './middleware/request-logger.js';
import { createAdminRouter } from './routes/admin.js';
import { createAuthRouter, type AuthRouterOptions } from './routes/auth.js';
import { createHealthRouter } from './routes/health.js';
import { createGoogleAuthRouter, type GoogleAuthRouterOptions } from './routes/google-auth.js';
import { createPasswordResetRouter, type PasswordResetRouterOptions } from './routes/password-reset.js';
import { createUsersRouter } from './routes/users.js';
import { createProfileRouter } from './routes/profile.js';
import { createOrgRouter } from './routes/org.js';
import { createProjectsRouter } from './routes/projects.js';
import { createTicketsRouter } from './routes/tickets.js';
import { createEscalationRouter } from './routes/escalation.js';
import { createTasksRouter } from './routes/tasks.js';
import { createServicesRouter } from './routes/services.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { createEventsRouter } from './routes/events.js';
import { createPricingRouter } from './routes/pricing.js';
import { createRolesRouter } from './routes/roles.js';
import { createAiPrdRouter } from './routes/ai-prd.js';

/**
 * The application factory.
 *
 * Order is the contract: security headers, then body parsing, then the request
 * log (so it wraps every route, including a body-parser rejection), then the
 * routes, then the two failure handlers - the 404 catch-all first and the error
 * handler last, because Express only treats the last one as the error handler.
 *
 * `cookieParser(env.SESSION_SECRET)` runs before the routes because the session
 * cookie is signed: this is what turns the cookie header into `req.signedCookies`
 * and what gives `res.cookie(..., { signed: true })` a secret to sign with.
 * Without it the cookie is unsigned - a value anybody could write - so a missing
 * secret has to fail loudly rather than degrade quietly.
 *
 * The factory exists so tests can build the same application the process runs,
 * with extra routers mounted in the same position production routers occupy.
 */

export interface CreateAppOptions {
  /**
   * Routers mounted after the health route and before the failure handlers.
   * Later slices mount their own routers inside this factory; the option exists
   * so a test can exercise the failure path through the real middleware stack.
   */
  routers?: Router[];
  /**
   * The credential-path seams: the clock, the sign-in limiter, the mailer, the
   * forgot-route limiter and the Google verifier. Left unset, each router builds
   * them from the validated environment, which is what the process runs. The
   * routers take disjoint slices of the bag - sign-in reads
   * `loginRateLimit`/`now`, password recovery reads
   * `mailer`/`now`/`forgotRateLimit`, Google reads `google`/`now` - so one option
   * object drives all three without any router knowing about another's seam.
   */
  auth?: AuthRouterOptions & PasswordResetRouterOptions & GoogleAuthRouterOptions;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: ['https://internal-ticket-tool-front.vercel.app', env.WEB_ORIGIN],
      credentials: true,
    })
  );
  app.use(cookieParser(env.SESSION_SECRET));
  app.use(express.json({ limit: '15mb' }));
  app.use(createRequestLogger());

  app.use(createHealthRouter());
  // Sign-in carries the login rate limiter and the account lockout (R015); the
  // clock seam is shared so a test can place a lockout deadline in the past.
  app.use(createAuthRouter(options.auth));
  // Password recovery shares the `/api/auth` namespace but lives in its own
  // router, because it is the one public credential surface besides sign-in and
  // it owns its own rate limit. `createApp` passes the mailer/clock/limiter
  // seams through the `auth` option so a test can drive the real stack.
  app.use(createPasswordResetRouter(options.auth));
  // Google sign-in (R013): the two browser-facing routes have to answer with
  // redirects, so they live in their own router. The verifier seam and the clock
  // come from the same `auth` bag; production passes nothing and gets the real
  // verifier built from GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.
  app.use(createGoogleAuthRouter({ verifier: options.auth?.google?.verifier, now: options.auth?.now }));
  // The administrator area. Every route inside carries `requireAuth` and a
  // named `requirePermission` key; `route-access.ts` records the only routes
  // allowed to skip them, and `tests/permission-coverage.test.ts` walks the
  // stack this factory builds to prove no route escapes that rule.
  app.use(createAdminRouter());
  app.use(createUsersRouter());
  app.use(createProfileRouter());
  app.use(createOrgRouter());
  app.use(createProjectsRouter());
  app.use(createTicketsRouter());
  app.use(createEscalationRouter());
  app.use(createTasksRouter());
  app.use(createServicesRouter());
  app.use(createDashboardRouter());
  app.use(createEventsRouter());
  app.use(createPricingRouter());
  app.use(createRolesRouter());
  app.use(createAiPrdRouter());
  for (const router of options.routers ?? []) {
    app.use(router);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
