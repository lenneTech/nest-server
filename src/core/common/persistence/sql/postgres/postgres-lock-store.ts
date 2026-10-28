import type { LockStore } from '../../lock-store.interface.js';
import type { SqlExecutor, SqlTenantScope } from '../sql-executor.interface.js';
import { quoteIdentifier } from '../sql-naming.js';
import { LOCK_MODEL, tableName } from '../sql-schema.shared.js';

const SYSTEM: SqlTenantScope = { kind: 'system' };
const TABLE = quoteIdentifier(tableName(LOCK_MODEL));

/**
 * Expired leases are deleted at most this often per process. A lease is only deleted by its owner's release — a cron
 * lease per tick, of a replica that died, is never released — and nothing else collects them (MongoDB has a TTL index
 * for that); the claim never needs the row gone, an expired one is taken over in place.
 */
const SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * Leases on PostgreSQL (plan §3.7) — the contract of `MongoLockStore`, decided by the database's clock in one
 * statement each.
 *
 * A claim inserts the lease, or takes over an EXPIRED one: `ON CONFLICT … DO UPDATE … WHERE expires_at <= now()`.
 * Concurrent contenders queue on the row lock, and each re-checks the condition against the version the winner
 * wrote, so exactly one of N gets the row back.
 */
export class PostgresLockStore implements LockStore {
  private lastSweep = 0;

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
    await this.sweep();
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

  /** Delete leases that expired over an hour ago — the hour keeps a just-expired holder visible for diagnosis */
  protected async sweep(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweep = now;
    await this.executor.run(
      { params: [], text: `DELETE FROM ${TABLE} WHERE "expires_at" < now() - interval '1 hour'` },
      SYSTEM,
    );
  }
}
