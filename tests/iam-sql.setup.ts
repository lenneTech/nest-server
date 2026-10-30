/**
 * Runs first in every worker of an IAM SQL project, before `config.env.ts` is imported: the project's SQL database
 * becomes the default data source through the same `NSC__DATABASE__*` variables a deployment sets, so the suites boot
 * the reference server unchanged. `iam-sql-<engine>` routes to PostgreSQL with that engine, `iam-mysql` / `iam-mariadb`
 * to MySQL / MariaDB with the default engine (DEV-3904). MongoDB stays configured (`mongoose`) for the models that are
 * not routed.
 *
 * Without the database the project's global setup could not create, every suite of the project fails here with the
 * reason — never silently on MongoDB, which would pass and prove nothing about the SQL database.
 */
export function routeIamSuitesToSql(): void {
  const engine = process.env.LT_TEST_IAM_SQL_ENGINE;
  const server = process.env.LT_TEST_IAM_SQL_SERVER;
  if (!engine && !server) {
    return;
  }
  const key = (server ?? engine)!.toUpperCase();
  const project = server ? `iam-${server}` : `iam-sql-${engine}`;
  const url = process.env[`LT_TEST_IAM_SQL_${key}_URL`];
  const ownerUrl = process.env[`LT_TEST_IAM_SQL_${key}_OWNER_URL`];
  if (!url || !ownerUrl) {
    const reason =
      process.env[`LT_TEST_IAM_SQL_${key}_ERROR`] ??
      'not created; start the test infrastructure with `pnpm run test:infra`';
    throw new Error(`No SQL database for project ${project}: ${reason} To run MongoDB alone: --project e2e.`);
  }
  process.env.NSC__DATABASE__URL = url;
  process.env.NSC__DATABASE__OWNER_URL = ownerUrl;
  if (engine) {
    process.env.NSC__DATABASE__SQL_ENGINE = engine;
  }
}

routeIamSuitesToSql();
