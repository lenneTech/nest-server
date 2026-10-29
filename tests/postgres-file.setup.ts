import { afterAll } from 'vitest';

import { createPostgresTestDatabase } from './helpers/postgres-test-db';

/**
 * Runs first for every test file of the `postgres` project, before `config.env.ts` is imported: a PostgreSQL database
 * of its own becomes the default data source through the same `NSC__DATABASE__*` variables a deployment sets, so the
 * suite boots the reference server unchanged. MongoDB stays configured (`mongoose`) for the models that are not routed.
 *
 * One database per FILE, not per run: suites differ in `multiTenancy`, and whether a table is tenant-isolated is part
 * of its schema — a suite without tenancy booting on tables another suite created with row-level security stops at the
 * schema check (measured: 25 of 115 files failed that way on a shared database).
 *
 * Without PostgreSQL every suite of the project fails here with the reason, never silently on MongoDB, which would
 * pass and prove nothing about PostgreSQL.
 */
const engine = process.env.LT_TEST_SQL_ENGINE ?? 'typeorm';

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>;
try {
  database = await createPostgresTestDatabase(`pf${process.pid}${Math.random().toString(36).slice(2, 7)}`);
} catch (error) {
  throw new Error(
    `No PostgreSQL database for the postgres project: ${error instanceof Error ? error.message : String(error)} ` +
      'Start the test infrastructure with `pnpm run test:infra`, or run MongoDB alone with --project e2e.',
    { cause: error },
  );
}

process.env.NSC__DATABASE__URL = database.appUrl;
process.env.NSC__DATABASE__OWNER_URL = database.ownerUrl;
process.env.NSC__DATABASE__SQL_ENGINE = engine;

afterAll(async () => {
  await database.drop();
});
