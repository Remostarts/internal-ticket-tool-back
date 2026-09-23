import dns from 'node:dns';
import mongoose from 'mongoose';
import { logger } from '../logging/logger.js';

/**
 * The MongoDB lifecycle.
 *
 * One connection, owned here so the API, the scripts and the tests cannot each
 * invent their own. `connectDatabase` throws a message that names the target
 * host and database and never the credentials - a connection string in a log or
 * an error body would put the database password wherever the log goes.
 */

export type DatabaseState = 'connected' | 'connecting' | 'disconnected';

/** mongoose readyState 0 disconnected, 1 connected, 2 connecting, 3 disconnecting. */
const READY_STATES: Record<number, DatabaseState> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnected',
  99: 'disconnected',
};

export function databaseState(): DatabaseState {
  return READY_STATES[mongoose.connection.readyState] ?? 'disconnected';
}

export function databaseName(): string | null {
  return mongoose.connection.name ?? null;
}

/** `host/database`, with any credentials stripped. Safe to log and to return. */
export function describeMongoTarget(uri: string): string {
  try {
    const parsed = new URL(uri);
    const database = parsed.pathname.replace(/^\/+/, '') || '(default database)';
    return `${parsed.host}/${database}`;
  } catch {
    return '(unreadable connection string)';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates every index declared on every registered model.
 *
 * Called on connect so the indexes the queries assume (R012) exist before the
 * first request rather than being created lazily under load.
 */
export async function syncIndexes(): Promise<number> {
  const models = Object.values(mongoose.models);
  await Promise.all(
    models.map(async (model) => {
      try {
        await model.createIndexes();
      } catch (err: any) {
        logger.warn(
          { model: model.modelName, code: err?.code, message: err?.message },
          'failed to sync some model indexes',
        );
      }
    }),
  );
  logger.debug({ models: models.length }, 'model indexes ensured');
  return models.length;
}

export interface ConnectOptions {
  /**
   * How long the driver waits for a reachable server before giving up. The
   * driver default is 30s, which is long enough that a wrong host looks like a
   * hang; the API deliberately fails fast and reports degraded health instead.
   */
  serverSelectionTimeoutMS?: number;
}

export async function connectDatabase(uri: string, options: ConnectOptions = {}): Promise<void> {
  if (databaseState() === 'connected') {
    logger.debug({ database: databaseName() }, 'database already connected');
    return;
  }

  const target = describeMongoTarget(uri);
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 5000,
      autoIndex: true,
    });
  } catch (error) {
    // If local router DNS fails to resolve SRV records (common on Windows local routers),
    // fall back to reliable public DNS resolvers (Google / Cloudflare) and retry once.
    if (errorMessage(error).includes('querySrv') && errorMessage(error).includes('ECONNREFUSED')) {
      logger.warn('local DNS failed SRV query; falling back to public DNS resolvers');
      dns.setServers(['8.8.8.8', '1.1.1.1']);
      try {
        await mongoose.connect(uri, {
          serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 5000,
          autoIndex: true,
        });
      } catch (retryError) {
        logger.error({ target, err: retryError }, 'database connection failed');
        throw new Error(`Could not connect to MongoDB at ${target}: ${errorMessage(retryError)}`);
      }
    } else {
      logger.error({ target, err: error }, 'database connection failed');
      throw new Error(`Could not connect to MongoDB at ${target}: ${errorMessage(error)}`);
    }
  }

  logger.info({ database: databaseName(), target }, 'database connected');
  await syncIndexes();
}

export async function disconnect(): Promise<void> {
  if (databaseState() === 'disconnected') {
    return;
  }
  await mongoose.disconnect();
  logger.debug('database disconnected');
}
