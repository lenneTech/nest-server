import type { LockStore } from '../../lock-store.interface.js';
import type { SqlExecutor, SqlTenantScope } from '../sql-executor.interface.js';
import { quoteIdentifier } from '../sql-naming.js';
import { LOCK_MODEL, tableName } from './postgres-schema.compiler.js';

const SYSTEM: SqlTenantScope = { kind: 'system' };
const TABLE = quoteIdentifier(tableName(LOCK_MODEL));

/**
 * Leases on PostgreSQL (plan §3.7) — the contract of `MongoLockStore`, decided by the database's clock in one
 * statement each.
 *
 * A claim inserts the lease, or takes over an EXPIRED one: `ON CONFLICT … DO UPDATE … WHERE expires_at <= now()`.
 * Concurrent contenders queue on the row lock, and each re-checks the condition against the version the winner
 * wrote, so exactly one of N gets the row back.
 */
export class PostgresLockStore implements LockStore {
  constructor(protected readonly executor: SqlExecutor) {}

  async release(key: string, owner: string): Promise<boolean> {
    const { rowCount } = await this.executor.run(
      { params: [key, owner], text: `DELETE FROM ${TABLE} WHERE "id" = $1 AND "owner" = $2` },
      SYSTEM,
    );
    return rowCount === 1;
  }

  async renew(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const { rowCount } = await this.executor.run(
      {
        params: [key, owner, ttlSeconds],
        text: `UPDATE ${TABLE} SET "expires_at" = now() + make_interval(secs => $3) WHERE "id" = $1 AND "owner" = $2 AND "expires_at" > now()`,
      },
      SYSTEM,
    );
    return rowCount === 1;
  }

  async tryAcquire(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const { rowCount } = await this.executor.run(
      {
        params: [key, owner, ttlSeconds],
        text: `INSERT INTO ${TABLE} ("id", "owner", "acquired_at", "expires_at")
          VALUES ($1, $2, now(), now() + make_interval(secs => $3))
          ON CONFLICT ("id") DO UPDATE SET "owner" = EXCLUDED."owner", "acquired_at" = EXCLUDED."acquired_at", "expires_at" = EXCLUDED."expires_at"
          WHERE ${TABLE}."expires_at" <= now()
          RETURNING "id"`,
      },
      SYSTEM,
    );
    return rowCount === 1;
  }
}
