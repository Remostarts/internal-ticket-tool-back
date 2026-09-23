import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDatabase, databaseState, disconnect } from './db/connect.js';
import { logger } from './logging/logger.js';

/**
 * The API process.
 *
 * Start-up order is connect, then listen, then seed. A database that cannot be
 * reached is not fatal: the process still listens so `GET /health` can report
 * `degraded` (a probe that goes dark exactly when something is wrong is worse
 * than no probe) and the failure is logged once, at error level, with the target
 * host and database but never the credentials.
 */

let shuttingDown = false;

function registerShutdownHandlers(server: Server): void {
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    server.close(() => {
      void disconnect()
        .catch((error: unknown) => logger.error({ err: error }, 'database disconnect failed'))
        .finally(() => process.exit(0));
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function bootstrap(): Promise<void> {
  try {
    await connectDatabase(env.MONGODB_URI);
  } catch (error) {
    logger.error(
      { err: error },
      'starting the API without a database connection; /health will report degraded',
    );
  }

  const server = createApp().listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, database: databaseState(), nodeEnv: env.NODE_ENV },
      'api listening',
    );
  });

  registerShutdownHandlers(server);
}

void bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, 'api failed to start');
  process.exitCode = 1;
});
