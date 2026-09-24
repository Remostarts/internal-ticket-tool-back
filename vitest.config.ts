import { defineConfig } from 'vitest/config';

/**
 * Server test configuration.
 *
 * `test.env` supplies the same configuration a deployment provides, with a
 * throwaway signing secret, because `config/env.ts` validates the environment
 * when it is imported - a suite that had to remember to export five variables
 * would fail for the wrong reason. `MONGODB_URI` here is a placeholder: the
 * helper in `tests/helpers/test-db.ts` decides the real database, using
 * `MONGODB_URI_TEST` when it is set and an in-process mongodb-memory-server
 * otherwise.
 *
 * One fork runs the files in order: mongoose keeps connection state in a module
 * singleton, and the health suite deliberately observes both a live and a dead
 * connection.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 120_000,
    restoreMocks: true,
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/claimdesk-test-placeholder',
      SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',



      LOG_LEVEL: 'silent',
    },
  },
});
