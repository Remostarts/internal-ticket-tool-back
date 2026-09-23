import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectDatabase, disconnect, syncIndexes } from '../../src/db/connect.js';

/**
 * The test database.
 *
 * Prefers `MONGODB_URI_TEST` when it is set (a CI service container, or a
 * developer's own instance) and falls back to an in-process mongodb-memory-server
 * otherwise, so `npm run test -w server` works from a clean checkout with no
 * database installed. `resetTestDatabase` drops the database and recreates the
 * indexes, so a suite starts from an empty, correctly indexed store.
 */

const TEST_DATABASE_NAME = 'claimdesk_test';

let memoryServer: MongoMemoryServer | null = null;

export interface TestDatabase {
  uri: string;
  kind: 'configured' | 'in-memory';
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const configured = process.env.MONGODB_URI_TEST?.trim();
  if (configured) {
    await connectDatabase(configured);
    return { uri: configured, kind: 'configured' };
  }

  if (!memoryServer) {
    memoryServer = await MongoMemoryServer.create();
  }
  const uri = memoryServer.getUri(TEST_DATABASE_NAME);
  await connectDatabase(uri);
  return { uri, kind: 'in-memory' };
}

/** Drops every collection and recreates the declared indexes. */
export async function resetTestDatabase(): Promise<void> {
  const { db } = mongoose.connection;
  if (!db) {
    throw new Error('resetTestDatabase was called before startTestDatabase');
  }
  await db.dropDatabase();
  await syncIndexes();
}

export async function stopTestDatabase(): Promise<void> {
  await disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}
