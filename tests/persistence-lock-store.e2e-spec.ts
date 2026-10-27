import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { LockStore } from '../src/core/common/persistence/lock-store.interface';
import { MongoLockStore } from '../src/core/common/persistence/mongo-lock-store';
import { deriveTestDbUri } from './db-lifecycle.reporter';

/**
 * The LockStore contract, against a real database. Every implementation (MongoDB now, SQL from phase 1)
 * must pass the same cases: they are what makes a lease a lease.
 */
describe('LockStore contract — mongodb (e2e)', () => {
  let client: MongoClient;
  let locks: LockStore;
  let collection: ReturnType<ReturnType<MongoClient['db']>['collection']>;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    client = await MongoClient.connect(deriveTestDbUri('lock-store'));
    collection = client.db().collection('parity-locks');
    locks = new MongoLockStore(collection);
  });

  beforeEach(async () => {
    await collection.deleteMany({});
  });

  afterAll(async () => {
    await client?.db().dropDatabase();
    await client?.close();
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
   *   in tests/regression-mutations.json.
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
    // The document is still there (no TTL monitor ran); the claim must still see it as expired
    expect(await collection.countDocuments({ _id: 'ttl' as any })).toBe(1);
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
