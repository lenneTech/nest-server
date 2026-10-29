/**
 * Runs first in every worker of an `iam-sql-<engine>` project, before `config.env.ts` is imported: PostgreSQL becomes
 * the default data source through the same `NSC__DATABASE__*` variables a deployment sets, so the suites boot the
 * reference server unchanged. MongoDB stays configured (`mongoose`) for the models that are not routed.
 *
 * Without the database the project's global setup could not create, every suite of the project fails here with the
 * reason — never silently on MongoDB, which would pass and prove nothing about PostgreSQL.
 */
export function routeIamSuitesToPostgres(): void {
  const engine = process.env.LT_TEST_IAM_SQL_ENGINE;
  if (!engine) {
    return;
  }
  const key = engine.toUpperCase();
  const url = process.env[`LT_TEST_IAM_SQL_${key}_URL`];
  const ownerUrl = process.env[`LT_TEST_IAM_SQL_${key}_OWNER_URL`];
  if (!url || !ownerUrl) {
    const reason =
      process.env[`LT_TEST_IAM_SQL_${key}_ERROR`] ??
      'not created; start the test infrastructure with `pnpm run test:infra`';
    throw new Error(
      `No PostgreSQL database for project iam-sql-${engine}: ${reason} To run MongoDB alone: --project e2e.`,
    );
  }
  process.env.NSC__DATABASE__URL = url;
  process.env.NSC__DATABASE__OWNER_URL = ownerUrl;
  process.env.NSC__DATABASE__SQL_ENGINE = engine;
}

routeIamSuitesToPostgres();
