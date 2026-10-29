import { Client } from 'pg';

import { deriveTestDbUri, isDroppableTestDb } from '../db-lifecycle.reporter';

/**
 * A PostgreSQL database per spec, with the role separation every environment uses (plan §3.9): the owner role
 * owns the database and its schema, the application role owns nothing and has neither BYPASSRLS nor superuser.
 * The container and both roles come from `scripts/test-infra.mjs` (locally) or `.github/actions/test-infra`
 * (CI) — same names, same passwords, overridable through the same environment variables.
 *
 * The database name follows the e2e run scheme (`deriveTestDbUri()`), so it carries the run's `e2e` segment and
 * passes the drop guard; a name that does not is refused before anything is created or dropped.
 */
export const PG_HOST = process.env.PG_HOST || '127.0.0.1';
export const PG_PORT = Number(process.env.PG_PORT || 5440);
export const PG_OWNER = {
  password: process.env.PG_OWNER_PASSWORD || 'nest-owner-secret',
  user: process.env.PG_OWNER_USER || 'nest_owner',
};
export const PG_APP = {
  password: process.env.PG_APP_PASSWORD || 'nest-app-secret',
  user: process.env.PG_APP_USER || 'nest_app',
};
const MAINTENANCE_DB = 'nest_server_e2e';

export interface PostgresTestDatabase {
  /** Connection URL as the application role */
  appUrl: string;
  /** Drop the database (and every connection to it) */
  drop(): Promise<void>;
  name: string;
  /** Connection URL as the owner role */
  ownerUrl: string;
}

export function postgresUrl(role: { password: string; user: string }, database: string): string {
  return `postgres://${encodeURIComponent(role.user)}:${encodeURIComponent(role.password)}@${PG_HOST}:${PG_PORT}/${database}`;
}

/** The run's database name for `suffix`, in Postgres form: lowercase, `-` → `_`, at most 63 characters. */
export function postgresTestDbName(suffix: string): string {
  const mongoUri = deriveTestDbUri(suffix);
  const name = new URL(mongoUri.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.slice(1);
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 63);
}

export async function createPostgresTestDatabase(suffix: string): Promise<PostgresTestDatabase> {
  const name = postgresTestDbName(suffix);
  if (!isDroppableTestDb(name)) {
    throw new Error(`Refusing to create the test database "${name}": its name does not pass the drop guard`);
  }

  const admin = new Client({ connectionString: postgresUrl(PG_OWNER, MAINTENANCE_DB) });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `PostgreSQL is not reachable on ${PG_HOST}:${PG_PORT} (${(error as Error).message}). ` +
        'Start the test infrastructure with `pnpm run test:infra` (container nest-server-2985-postgres).',
      { cause: error },
    );
  }
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}" OWNER "${PG_OWNER.user}"`);
    await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO "${PG_APP.user}"`);
  } finally {
    await admin.end();
  }

  return {
    appUrl: postgresUrl(PG_APP, name),
    drop: async () => {
      const client = new Client({ connectionString: postgresUrl(PG_OWNER, MAINTENANCE_DB) });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
    name,
    ownerUrl: postgresUrl(PG_OWNER, name),
  };
}

/**
 * In the projects that run on PostgreSQL (`postgres`, `iam-sql-<engine>`): a database of the caller's own, for an
 * application whose tables must not be shared with the rest of its file — a different `multiTenancy` changes their
 * row-level security, and the system setup needs an empty user base. `undefined` in a MongoDB run.
 */
export async function ownPostgresDatabase(suffix: string): Promise<PostgresTestDatabase | undefined> {
  return process.env.NSC__DATABASE__OWNER_URL ? createPostgresTestDatabase(`${suffix}-${process.pid}`) : undefined;
}

/** The configuration on the caller's own PostgreSQL database, when it has one; unchanged otherwise */
export function onOwnPostgresDatabase<T extends object>(config: T, sql: PostgresTestDatabase | undefined): T {
  return sql
    ? {
        ...config,
        database: { ownerUrl: sql.ownerUrl, sqlEngine: process.env.NSC__DATABASE__SQL_ENGINE, url: sql.appUrl },
      }
    : config;
}
