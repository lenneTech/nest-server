import { createMysqlTestDatabase } from './mysql-test-db';
import { createPostgresTestDatabase } from './postgres-test-db';

/** A SQL database a suite creates for itself, on the server the project routes to */
export interface OwnSqlTestDatabase {
  appUrl: string;
  drop(): Promise<void>;
  ownerUrl: string;
}

/**
 * A database of the suite's own on the SQL server the project runs on — PostgreSQL in the `postgres` and
 * `iam-sql-<engine>` projects, MySQL / MariaDB in `iam-mysql` / `iam-mariadb` (DEV-3904); `undefined` on MongoDB. For a
 * suite whose configuration (`multiTenancy`) must not share the project's database with the other suites.
 */
export async function createOwnSqlTestDatabase(suffix: string): Promise<OwnSqlTestDatabase | undefined> {
  if (!process.env.NSC__DATABASE__OWNER_URL) {
    return undefined;
  }
  const server = /^(mysql|mariadb):/.exec(process.env.NSC__DATABASE__URL ?? '')?.[1] as 'mariadb' | 'mysql' | undefined;
  return server ? createMysqlTestDatabase(server, suffix) : createPostgresTestDatabase(suffix);
}
