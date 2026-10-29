import { up as startTestInfra } from '../scripts/test-infra.mjs';
import { createPostgresTestDatabase } from './helpers/postgres-test-db';

/**
 * The PostgreSQL database of one `iam-sql-<engine>` project: created before the workers start, dropped when the run
 * ends. Named after the process too — a project's setup runs BEFORE the root setup names the run, and two runs on one
 * machine must not share (and drop) each other's database.
 *
 * Never fatal for the run. vitest runs the global setup of EVERY project before any test, and the project setups
 * before the root one: a throw here stopped the whole run, the MongoDB project included, before `tests/global-setup.ts`
 * could start the containers. So the containers are started here too (idempotent, once per run, `LT_TEST_INFRA=0`
 * honoured), and a database that still cannot be created is handed to the project's setup file, which fails every
 * suite of this project with the reason — loudly, but only here.
 */
export default async function setup(project: { name: string }): Promise<() => Promise<void>> {
  const engine = project.name.replace(/^iam-sql-/, '');
  const key = engine.toUpperCase();
  await startInfrastructureOnce();
  try {
    const database = await createPostgresTestDatabase(`iam-sql-${engine}-${process.pid}`);
    process.env[`LT_TEST_IAM_SQL_${key}_URL`] = database.appUrl;
    process.env[`LT_TEST_IAM_SQL_${key}_OWNER_URL`] = database.ownerUrl;
    return () => database.drop();
  } catch (error) {
    process.env[`LT_TEST_IAM_SQL_${key}_ERROR`] = error instanceof Error ? error.message : String(error);
    return async () => undefined;
  }
}

/** Shared by the three projects' setups, which run in the same process */
export const INFRA_STARTED = Symbol.for('lenne.tech:iam-sql-infra-started');

/** One start for all three projects */
function startInfrastructureOnce(): Promise<unknown> {
  const shared = globalThis as Record<symbol, Promise<unknown> | undefined>;
  shared[INFRA_STARTED] ??= startTestInfra().catch((error: unknown) => {
    console.warn(`Test infrastructure not started: ${error instanceof Error ? error.message : 'Unknown error'}`);
  });
  return shared[INFRA_STARTED];
}
