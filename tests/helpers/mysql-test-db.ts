import { createConnection } from 'mysql2/promise';

import type { MysqlVariant } from '../../src/core/common/persistence/sql/mysql/mysql-session';
import { isDroppableTestDb } from '../db-lifecycle.reporter';
import { postgresTestDbName } from './postgres-test-db';

/**
 * A MySQL 8.4 or MariaDB 11.8 database per spec, with the two roles every environment uses (plan §3.9, phase 6): the
 * owner creates and changes tables, the application role may only read and write rows — granted on this one database,
 * never globally. The containers and both users come from `scripts/test-infra.mjs` (locally) or
 * `.github/actions/test-infra` (CI) — same names, same passwords, overridable through the same environment variables.
 *
 * The database name follows the e2e run scheme, so it carries the run's `e2e` segment and passes the drop guard; a
 * name that does not is refused before anything is created or dropped.
 */
export const MYSQL_TEST_SERVERS: Record<MysqlVariant, { host: string; port: number }> = {
  mariadb: { host: process.env.MARIADB_HOST || '127.0.0.1', port: Number(process.env.MARIADB_PORT || 3317) },
  mysql: { host: process.env.MYSQL_HOST || '127.0.0.1', port: Number(process.env.MYSQL_PORT || 3316) },
};
export const MYSQL_OWNER = {
  password: process.env.MYSQL_OWNER_PASSWORD || 'nest-owner-secret',
  user: process.env.MYSQL_OWNER_USER || 'nest_owner',
};
export const MYSQL_APP = {
  password: process.env.MYSQL_APP_PASSWORD || 'nest-app-secret',
  user: process.env.MYSQL_APP_USER || 'nest_app',
};

export interface MysqlTestDatabase {
  /** Connection URL as the application role */
  appUrl: string;
  /** Drop the database and withdraw the application role's grant on it */
  drop(): Promise<void>;
  name: string;
  /** Connection URL as the owner role */
  ownerUrl: string;
  variant: MysqlVariant;
}

export function mysqlUrl(variant: MysqlVariant, role: { password: string; user: string }, database = ''): string {
  const { host, port } = MYSQL_TEST_SERVERS[variant];
  return `${variant}://${encodeURIComponent(role.user)}:${encodeURIComponent(role.password)}@${host}:${port}/${database}`;
}

async function ownerConnection(variant: MysqlVariant) {
  const { host, port } = MYSQL_TEST_SERVERS[variant];
  try {
    return await createConnection({ host, password: MYSQL_OWNER.password, port, user: MYSQL_OWNER.user });
  } catch (error) {
    const container = variant === 'mysql' ? 'nest-server-2985-mysql' : 'nest-server-2985-mariadb';
    throw new Error(
      `${variant === 'mysql' ? 'MySQL' : 'MariaDB'} is not reachable on ${host}:${port} (${(error as Error).message}). ` +
        `Start the test infrastructure with \`pnpm run test:infra\` (container ${container}).`,
      { cause: error },
    );
  }
}

export async function createMysqlTestDatabase(variant: MysqlVariant, suffix: string): Promise<MysqlTestDatabase> {
  const name = postgresTestDbName(`${suffix}-${variant}`);
  if (!isDroppableTestDb(name)) {
    throw new Error(`Refusing to create the test database "${name}": its name does not pass the drop guard`);
  }
  const app = `'${MYSQL_APP.user}'@'%'`;

  const admin = await ownerConnection(variant);
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${name}\`.* TO ${app}`);
  } finally {
    await admin.end();
  }

  return {
    appUrl: mysqlUrl(variant, MYSQL_APP, name),
    drop: async () => {
      const connection = await ownerConnection(variant);
      try {
        // A database-level grant outlives its database; withdrawn first, it cannot pile up across runs
        await connection.query(`REVOKE ALL PRIVILEGES ON \`${name}\`.* FROM ${app}`).catch(() => undefined);
        await connection.query(`DROP DATABASE IF EXISTS \`${name}\``);
      } finally {
        await connection.end();
      }
    },
    name,
    ownerUrl: mysqlUrl(variant, MYSQL_OWNER, name),
    variant,
  };
}
