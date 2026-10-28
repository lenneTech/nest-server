import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrationMongoLocks, systemSetupMongoLocks } from '../src/core/common/persistence/infrastructure-locks';
import type { LockStore } from '../src/core/common/persistence/lock-store.interface';
import { MongoLockStore } from '../src/core/common/persistence/mongo-lock-store';
import { PostgresLockStore } from '../src/core/common/persistence/sql/postgres/postgres-lock-store';
import { applyPostgresSchema } from '../src/core/common/persistence/sql/postgres/postgres-schema.migrator';
import { createSqlExecutor } from '../src/core/common/persistence/sql/sql-executor.factory';
import { deriveTestDbUri } from './db-lifecycle.reporter';
import { createPostgresTestDatabase, PG_APP } from './helpers/postgres-test-db';

/**
 * The LockStore contract, against real databases. Every implementation must pass the same cases: they are what
 * makes a lease a lease.
 */
interface LockHarness {
  locks: LockStore;
  reset(): Promise<void>;
  /** Whether the lease record of `key` is still stored */
  stored(key: string): Promise<boolean>;
  teardown(): Promise<void>;
}

async function mongoLocks(
  collectionName = 'parity-locks',
  create: (collection: any) => LockStore = (collection) => new MongoLockStore(collection),
  keyField = '_id',
): Promise<LockHarness> {
  const client = await MongoClient.connect(deriveTestDbUri('lock-store'));
  const collection = client.db().collection(collectionName);
  return {
    locks: create(collection),
    reset: async () => {
      await collection.deleteMany({});
    },
    stored: async (key) => (await collection.countDocuments({ [keyField]: key as any })) === 1,
    teardown: async () => {
      await collection.drop().catch(() => undefined);
      await client.close();
    },
  };
}

async function postgresLocks(): Promise<LockHarness> {
  const database = await createPostgresTestDatabase('lock-store');
  const owner = await createSqlExecutor({ engine: 'typeorm', maxConnections: 1, url: database.ownerUrl });
  try {
    await applyPostgresSchema(owner, [], { appRole: PG_APP.user, isTenantIsolated: () => false });
  } finally {
    await owner.close();
  }
  const app = await createSqlExecutor({ engine: 'kysely', maxConnections: 16, url: database.appUrl });
  return {
    locks: new PostgresLockStore(app),
    reset: async () => {
      await app.run({ params: [], text: 'DELETE FROM lt_locks' }, { kind: 'system' });
    },
    stored: async (key) =>
      (await app.run({ params: [key], text: 'SELECT 1 FROM lt_locks WHERE id = $1' }, { kind: 'system' })).rowCount ===
      1,
    teardown: async () => {
      await app.close();
      await database.drop();
    },
  };
}

/**
 * The two MongoDB lock formats of 12.0.0 that the framework's own locks keep (`infrastructure-locks.ts`) must be leases
 * like any other — the contract runs against them too
 */
const HARNESSES: Record<string, () => Promise<LockHarness>> = {
  mongodb: () => mongoLocks(),
  'mongodb (migration-lock format)': () => mongoLocks('parity-migration-locks', migrationMongoLocks, 'lock'),
  'mongodb (system-setup format)': () => mongoLocks('parity-setup-locks', systemSetupMongoLocks),
  postgres: postgresLocks,
};

describe.each(Object.keys(HARNESSES))('LockStore contract — %s (e2e)', (driver) => {
  let harness: LockHarness;
  let locks: LockStore;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    harness = await HARNESSES[driver]();
    locks = harness.locks;
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness?.teardown();
  });

  it('lets exactly one of 16 concurrent contenders win, round after round', async () => {
    for (let round = 0; round < 10; round++) {
      const results = await Promise.all(
        Array.from({ length: 16 }, (_, worker) => locks.tryAcquire(`key-${round}`, `worker-${worker}`, 30)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    }
  });

  /**
   * @regression   DEV-3828 (db-agnostic phase 0) — a lease claim that does not compare expiresAt takes over
   *   a held, unexpired lease, so two replicas run what exactly one of them may run.
   * @seen-failing Drop `expiresAt: { $lte: now }` from the claim filter in
   *   src/core/common/persistence/mongo-lock-store.ts — registered as mutation `lock-store-takes-held-lease`
   *   in tests/regression-mutations.json; on PostgreSQL drop the `WHERE … expires_at <= now()` of the claim in
   *   src/core/common/persistence/sql/postgres/postgres-lock-store.ts — mutation `sql-lock-store-takes-held-lease`.
   */
  it('never takes a held, unexpired lease — not even for its own owner', async () => {
    expect(await locks.tryAcquire('held', 'a', 30)).toBe(true);
    expect(await locks.tryAcquire('held', 'b', 30)).toBe(false);
    expect(await locks.tryAcquire('held', 'a', 30)).toBe(false);
  });

  it('hands an expired lease to exactly one of the contenders', async () => {
    expect(await locks.tryAcquire('stale', 'gone', 1)).toBe(true);
    await sleep(1100);
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, worker) => locks.tryAcquire('stale', `worker-${worker}`, 30)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('decides expiry at claim time, not through a background monitor', async () => {
    expect(await locks.tryAcquire('ttl', 'a', 1)).toBe(true);
    await sleep(1100);
    // The record is still there (no TTL monitor ran); the claim must still see it as expired
    expect(await harness.stored('ttl')).toBe(true);
    expect(await locks.tryAcquire('ttl', 'b', 30)).toBe(true);
  });

  it('renews only for the owner, and only while the lease is alive', async () => {
    expect(await locks.tryAcquire('renew', 'a', 1)).toBe(true);
    expect(await locks.renew('renew', 'b', 30)).toBe(false);
    expect(await locks.renew('renew', 'a', 30)).toBe(true);
    await sleep(1100);
    // Renewed to 30 s, so it is still held
    expect(await locks.tryAcquire('renew', 'b', 30)).toBe(false);

    expect(await locks.tryAcquire('lapsed', 'a', 1)).toBe(true);
    await sleep(1100);
    expect(await locks.renew('lapsed', 'a', 30)).toBe(false);
  });

  it('releases only for the owner', async () => {
    expect(await locks.tryAcquire('release', 'a', 30)).toBe(true);
    expect(await locks.release('release', 'b')).toBe(false);
    expect(await locks.tryAcquire('release', 'b', 30)).toBe(false);
    expect(await locks.release('release', 'a')).toBe(true);
    expect(await locks.tryAcquire('release', 'b', 30)).toBe(true);
  });
});

describe('PostgresLockStore housekeeping (e2e)', () => {
  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — a cron lease is written per tick and only its owner releases it, so
   *   without a sweep the lease table on PostgreSQL grew by one row per job and tick forever (MongoDB has a TTL index).
   * @seen-failing Make PostgresLockStore.sweep() return at once in
   *   src/core/common/persistence/sql/postgres/postgres-lock-store.ts — registered as mutation
   *   `sql-lock-store-never-sweeps` in tests/regression-mutations.json.
   */
  it('deletes leases that expired over an hour ago, and keeps the others', async () => {
    const harness = await postgresLocks();
    try {
      const run = (text: string) => (harness.locks as any).executor.run({ params: [], text }, { kind: 'system' });
      await run(
        `INSERT INTO lt_locks (id, owner, acquired_at, expires_at) VALUES ('old', 'gone', now() - interval '3 hours', now() - interval '2 hours'), ('recent', 'gone', now() - interval '20 minutes', now() - interval '10 minutes')`,
      );
      expect(await harness.locks.tryAcquire('fresh', 'a', 30)).toBe(true);
      expect(await harness.stored('old')).toBe(false);
      expect(await harness.stored('recent')).toBe(true);
    } finally {
      await harness.teardown();
    }
  });
});
