import type { LockStore } from '../../lock-store.interface.js';
import type { SqlExecutor, SqlTenantScope } from '../sql-executor.interface.js';
import { quoteMysqlIdentifier } from '../sql-naming.js';
import { LOCK_MODEL, tableName } from '../sql-schema.shared.js';

const SYSTEM: SqlTenantScope = { kind: 'system' };
const TABLE = quoteMysqlIdentifier(tableName(LOCK_MODEL));
/** The lease id column is varchar(255); a longer key would be refused by the INSERT and taken for "held" */
const MAX_KEY_LENGTH = 255;
/** Expired leases are deleted at most this often per process (see `PostgresLockStore`) */
const SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * Leases on MySQL and MariaDB (plan §3.7, phase 6) — the contract of `MongoLockStore` and `PostgresLockStore`, decided
 * by the database's clock (`UTC_TIMESTAMP(3)`, independent of the session's time zone).
 *
 * A claim is two statements, because neither server reports whether an upsert inserted, took over or left a row as it
 * was: `INSERT IGNORE` takes a free key, a conditional `UPDATE … WHERE expires_at <= now` takes over an EXPIRED lease.
 * Concurrent contenders queue on the row lock, and the `UPDATE` re-checks the condition against the version the winner
 * wrote, so exactly one of N gets the row.
 */
export class MysqlLockStore implements LockStore {
  private lastSweep = 0;

  constructor(protected readonly executor: SqlExecutor) {}

  async release(key: string, owner: string): Promise<boolean> {
    const { rowCount } = await this.executor.run(
      { params: [key, owner], text: `DELETE FROM ${TABLE} WHERE \`id\` = $1 AND \`owner\` = $2` },
      SYSTEM,
    );
    return rowCount === 1;
  }

  async renew(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const { rowCount } = await this.executor.run(
      {
        params: [key, owner, ttlSeconds],
        text: `UPDATE ${TABLE} SET \`expires_at\` = UTC_TIMESTAMP(3) + INTERVAL $3 SECOND
          WHERE \`id\` = $1 AND \`owner\` = $2 AND \`expires_at\` > UTC_TIMESTAMP(3)`,
      },
      SYSTEM,
    );
    return rowCount === 1;
  }

  async tryAcquire(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    if (key.length > MAX_KEY_LENGTH) {
      throw new Error(`A lease key may have at most ${MAX_KEY_LENGTH} characters`);
    }
    await this.sweep();
    const inserted = await this.executor.run(
      {
        params: [key, owner, ttlSeconds],
        text: `INSERT IGNORE INTO ${TABLE} (\`id\`, \`owner\`, \`acquired_at\`, \`expires_at\`)
          VALUES ($1, $2, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3) + INTERVAL $3 SECOND)`,
      },
      SYSTEM,
    );
    if (inserted.rowCount === 1) {
      return true;
    }
    const taken = await this.executor.run(
      {
        params: [key, owner, ttlSeconds],
        text: `UPDATE ${TABLE} SET \`owner\` = $2, \`acquired_at\` = UTC_TIMESTAMP(3),
            \`expires_at\` = UTC_TIMESTAMP(3) + INTERVAL $3 SECOND
          WHERE \`id\` = $1 AND \`expires_at\` <= UTC_TIMESTAMP(3)`,
      },
      SYSTEM,
    );
    return taken.rowCount === 1;
  }

  /** Delete leases that expired over an hour ago — the hour keeps a just-expired holder visible for diagnosis */
  protected async sweep(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweep = now;
    await this.executor.run(
      { params: [], text: `DELETE FROM ${TABLE} WHERE \`expires_at\` < UTC_TIMESTAMP(3) - INTERVAL 1 HOUR` },
      SYSTEM,
    );
  }
}
