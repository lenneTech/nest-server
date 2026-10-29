import { randomUUID } from 'node:crypto';

import { type Collection, MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cronMongoLocks,
  MIGRATION_LOCK_KEY,
  MIGRATION_LOCK_STALE_AFTER_MS,
  migrationMongoLocks,
  SYSTEM_SETUP_CLAIM_STALE_AFTER_MS,
  SYSTEM_SETUP_LOCK_KEY,
  systemSetupMongoLocks,
} from '../src/core/common/persistence/infrastructure-locks';
import type { LockStore } from '../src/core/common/persistence/lock-store.interface';
import { deriveTestDbUri } from './db-lifecycle.reporter';

/**
 * Mixed operation in a rolling deploy (DEV-3830 acceptance criterion): a replica still running 12.0.0 claims a lock
 * through its own code, a replica of this version through the `LockStore` — and the two must never hold the same lock
 * at once, in either direction, for any of the three framework locks.
 *
 * The OLD side below is the 12.0.0 code, reduced to the statements that decide the claim (same filters, same updates,
 * same error handling). It is quoted rather than imported because the point is that it does NOT change.
 */

const DUPLICATE_KEY = 11000;
const isDuplicate = (error: unknown) =>
  error instanceof Error && (error.message.includes('duplicate key') || error.message.includes('E11000'));

// --- 12.0.0: core-system-setup.service.ts → claimInitialAdminSetup() / releaseInitialAdminSetupClaim() -------------
async function oldSetupClaim(collection: Collection<any>): Promise<boolean> {
  try {
    const staleBefore = new Date(Date.now() - SYSTEM_SETUP_CLAIM_STALE_AFTER_MS);
    await collection.deleteOne({ _id: SYSTEM_SETUP_LOCK_KEY as any, claimedAt: { $lt: staleBefore } });
    const previous = await collection.findOneAndUpdate(
      { _id: SYSTEM_SETUP_LOCK_KEY as any },
      { $setOnInsert: { claimedAt: new Date() } },
      { returnDocument: 'before', upsert: true },
    );
    return !previous;
  } catch (error) {
    if (isDuplicate(error)) {
      return false;
    }
    throw error;
  }
}

// --- 12.0.0: core-cron-jobs.service.ts → acquireLease() (MongoDB branch) -------------------------------------------
async function oldCronLease(collection: Collection<any>, key: string, ttlSeconds: number): Promise<boolean> {
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  try {
    await collection.insertOne({ _id: key as any, expiresAt: new Date(Date.now() + ttlSeconds * 1000) });
    return true;
  } catch (error) {
    if ((error as { code?: number })?.code === DUPLICATE_KEY) {
      return false;
    }
    throw error;
  }
}

// --- 12.0.0: mongo-state-store.ts → one round of acquireLock(), and the heartbeat ----------------------------------
/** The token when this round took the lock, `undefined` when it would wait */
async function oldMigrationAcquireRound(collection: Collection<any>): Promise<string | undefined> {
  await collection.createIndex({ lock: 1 }, { unique: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await collection.updateOne(
      { lock: 'lock' },
      { $set: { lock: 'lock' }, $setOnInsert: { acquiredAt: new Date(), owner: token } },
      { upsert: true },
    );
    if (result.upsertedCount > 0) {
      return token;
    }
    const holder = await collection.findOne({ lock: 'lock' });
    if (!holder) {
      continue;
    }
    const acquiredAt = holder.acquiredAt instanceof Date ? holder.acquiredAt : undefined;
    if (!acquiredAt) {
      await collection.updateOne(
        { _id: holder._id, acquiredAt: { $exists: false } },
        { $set: { acquiredAt: new Date() } },
      );
      return undefined;
    }
    if (Date.now() - acquiredAt.getTime() > MIGRATION_LOCK_STALE_AFTER_MS) {
      await collection.deleteOne({ _id: holder._id, acquiredAt });
      continue;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Let time pass for one lock document: every timestamp it CARRIES moves `ms` into the past, a missing one stays
 * missing. Writing the old timestamp in a test instead would supply exactly what the code under test must write.
 */
async function age(collection: Collection<any>, filter: Record<string, unknown>, ms: number): Promise<void> {
  const shift = (field: string) => ({
    [field]: { $cond: [{ $eq: [{ $type: `$${field}` }, 'date'] }, { $subtract: [`$${field}`, ms] }, '$$REMOVE'] },
  });
  await collection.updateOne(filter, [
    { $set: { ...shift('acquiredAt'), ...shift('claimedAt'), ...shift('expiresAt') } },
  ]);
}

describe('Framework locks in mixed operation, 12.0.0 next to the LockStore (e2e)', () => {
  let client: MongoClient;
  let collection: Collection<any>;
  const ago = (ms: number) => new Date(Date.now() - ms);

  beforeAll(async () => {
    client = await MongoClient.connect(deriveTestDbUri('lock-formats'));
  });

  beforeEach(async () => {
    collection = client.db().collection(`lock-format-${randomUUID()}`);
  });

  afterAll(async () => {
    await client?.db().dropDatabase();
    await client?.close();
  });

  describe('system-setup claim', () => {
    let locks: LockStore;

    beforeEach(() => {
      locks = systemSetupMongoLocks(collection);
    });

    it('refuses the new claim while an old replica holds it', async () => {
      expect(await oldSetupClaim(collection)).toBe(true);
      expect(await locks.tryAcquire(SYSTEM_SETUP_LOCK_KEY, 'new', 300)).toBe(false);
    });

    it('refuses the old claim while a new replica holds it', async () => {
      expect(await locks.tryAcquire(SYSTEM_SETUP_LOCK_KEY, 'new', 300)).toBe(true);
      expect(await oldSetupClaim(collection)).toBe(false);
    });

    /**
     * @regression   DEV-3830 (db-agnostic phase 2) — the LockStore read only `expiresAt`, so a claim an old replica
     *   left behind (only `claimedAt`) was obeyed forever: a deployment whose first rollout died mid-setup could never
     *   create its admin.
     * @seen-failing Drop the `legacyTimestamp` branch of the claim filter in
     *   src/core/common/persistence/mongo-lock-store.ts — registered as mutation `lock-store-ignores-legacy-timestamp`
     *   in tests/regression-mutations.json.
     */
    it('takes over a stale old claim — exactly one of the new contenders', async () => {
      await collection.insertOne({
        _id: SYSTEM_SETUP_LOCK_KEY as any,
        claimedAt: ago(SYSTEM_SETUP_CLAIM_STALE_AFTER_MS + 1000),
      });
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, worker) => locks.tryAcquire(SYSTEM_SETUP_LOCK_KEY, `new-${worker}`, 300)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    /**
     * @regression   DEV-3830 (db-agnostic phase 2) — a claim without the old timestamp is invisible to the stale rule of
     *   an old replica, so after a new replica died mid-setup the old ones never took the claim over.
     * @seen-failing Return `{}` from MongoLockStore.legacyStamp() in src/core/common/persistence/mongo-lock-store.ts —
     *   registered as mutation `lock-store-skips-legacy-stamp` in tests/regression-mutations.json.
     */
    it('lets an old replica take over a stale new claim', async () => {
      expect(await locks.tryAcquire(SYSTEM_SETUP_LOCK_KEY, 'new', SYSTEM_SETUP_CLAIM_STALE_AFTER_MS / 1000)).toBe(true);
      await age(collection, { _id: SYSTEM_SETUP_LOCK_KEY }, SYSTEM_SETUP_CLAIM_STALE_AFTER_MS + 1000);
      expect(await oldSetupClaim(collection)).toBe(true);
      expect(await locks.tryAcquire(SYSTEM_SETUP_LOCK_KEY, 'other', 300)).toBe(false);
    });

    it('lets exactly one of old and new contenders win a free claim', async () => {
      const results = await Promise.all([
        ...Array.from({ length: 6 }, () => oldSetupClaim(collection)),
        ...Array.from({ length: 6 }, (_, worker) => locks.tryAcquire(SYSTEM_SETUP_LOCK_KEY, `new-${worker}`, 300)),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('cron lease', () => {
    let locks: LockStore;

    beforeEach(() => {
      locks = cronMongoLocks(collection);
    });

    it('refuses the new lease while an old replica holds the tick', async () => {
      expect(await oldCronLease(collection, 'job:tick-1', 3600)).toBe(true);
      expect(await locks.tryAcquire('job:tick-1', 'new', 3600)).toBe(false);
    });

    it('refuses the old lease while a new replica holds the tick', async () => {
      expect(await locks.tryAcquire('job:tick-1', 'new', 3600)).toBe(true);
      expect(await oldCronLease(collection, 'job:tick-1', 3600)).toBe(false);
    });

    it('takes over an expired old lease without waiting for the TTL monitor', async () => {
      await collection.insertOne({ _id: 'job:tick-1' as any, expiresAt: ago(1000) });
      expect(await locks.tryAcquire('job:tick-1', 'new', 3600)).toBe(true);
    });

    it('lets exactly one of old and new contenders win a tick', async () => {
      const results = await Promise.all([
        ...Array.from({ length: 6 }, () => oldCronLease(collection, 'job:tick-2', 3600)),
        ...Array.from({ length: 6 }, (_, worker) => locks.tryAcquire('job:tick-2', `new-${worker}`, 3600)),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('migration lock', () => {
    let locks: LockStore;
    const ttl = MIGRATION_LOCK_STALE_AFTER_MS / 1000;

    beforeEach(() => {
      locks = migrationMongoLocks(collection);
    });

    it('refuses the new lock while an old replica migrates', async () => {
      expect(await oldMigrationAcquireRound(collection)).toBeTruthy();
      expect(await locks.tryAcquire(MIGRATION_LOCK_KEY, 'new', ttl)).toBe(false);
    });

    /**
     * @regression   DEV-3830 (db-agnostic phase 2) — keyed on `_id`, the LockStore wrote a second lock document beside
     *   the old `{ lock: 'lock' }` one, and an old and a new replica migrated at the same time.
     * @seen-failing Construct the migration lock store without `keyField: 'lock'` in
     *   src/core/common/persistence/infrastructure-locks.ts — registered as mutation `migration-lock-own-document` in
     *   tests/regression-mutations.json.
     */
    it('refuses the old lock while a new replica migrates', async () => {
      expect(await locks.tryAcquire(MIGRATION_LOCK_KEY, 'new', ttl)).toBe(true);
      expect(await oldMigrationAcquireRound(collection)).toBeUndefined();
    });

    it('keeps a renewed new lock alive for an old waiter, and lets it break a lock that stopped renewing', async () => {
      // A lease longer than the old stale period, so only the heartbeat the old waiter reads decides
      expect(await locks.tryAcquire(MIGRATION_LOCK_KEY, 'new', 3 * ttl)).toBe(true);
      await age(collection, { lock: 'lock' }, MIGRATION_LOCK_STALE_AFTER_MS + 1000);
      expect(await locks.renew(MIGRATION_LOCK_KEY, 'new', 3 * ttl)).toBe(true);
      expect(await oldMigrationAcquireRound(collection)).toBeUndefined();

      await age(collection, { lock: 'lock' }, 3 * MIGRATION_LOCK_STALE_AFTER_MS + 1000);
      expect(await oldMigrationAcquireRound(collection)).toBeTruthy();
      expect(await locks.tryAcquire(MIGRATION_LOCK_KEY, 'other', ttl)).toBe(false);
    });

    it('breaks an old lock that stopped heart-beating — exactly one of the new contenders', async () => {
      await collection.createIndex({ lock: 1 }, { unique: true });
      await collection.insertOne({
        acquiredAt: ago(MIGRATION_LOCK_STALE_AFTER_MS + 1000),
        lock: 'lock',
        owner: 'gone',
      });
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, worker) => locks.tryAcquire(MIGRATION_LOCK_KEY, `new-${worker}`, ttl)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await collection.countDocuments({})).toBe(1);
    });

    it('starts the clock of a lock written without any timestamp instead of obeying it forever', async () => {
      await collection.createIndex({ lock: 1 }, { unique: true });
      await collection.insertOne({ lock: 'lock' });
      expect(await locks.tryAcquire(MIGRATION_LOCK_KEY, 'new', ttl)).toBe(false);
      expect((await collection.findOne({ lock: 'lock' }))?.acquiredAt).toBeInstanceOf(Date);
    });

    it('lets exactly one of old and new contenders win a free lock', async () => {
      const results = await Promise.all([
        ...Array.from({ length: 6 }, () => oldMigrationAcquireRound(collection)),
        ...Array.from({ length: 6 }, (_, worker) => locks.tryAcquire(MIGRATION_LOCK_KEY, `new-${worker}`, ttl)),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await collection.countDocuments({})).toBe(1);
    });
  });
});
