import type { Collection } from 'mongodb';

import type { LockStore } from './lock-store.interface.js';
import { MongoLockStore } from './mongo-lock-store.js';
import { getPersistenceRuntime } from './persistence-runtime.registry.js';

/**
 * The framework's own locks — the system-setup claim, the cron lease and the migration lock — on a `LockStore`.
 *
 * On MongoDB each one keeps the document 12.0.0 wrote (same collection, same key, same timestamp field): during a
 * rolling deploy an older replica still claims through its own code, and only one document per lock lets both
 * versions see the same lease. The `MongoLockStore` options below encode each format. On a SQL default source the
 * locks live in the lease table, namespaced per consumer.
 */

/** Cron leases: `{ _id: <tick key>, expiresAt }` — already the lease format, so no legacy rule is needed */
export const CRON_LOCK_COLLECTION = 'cron-locks';

export const SYSTEM_SETUP_LOCK_COLLECTION = 'system-setup-locks';
export const SYSTEM_SETUP_LOCK_KEY = 'initial-admin';
/** The claim is taken over once it is this old: a replica killed between claiming and creating must not block setup */
export const SYSTEM_SETUP_CLAIM_STALE_AFTER_MS = 5 * 60_000;

export const MIGRATION_LOCK_KEY = 'lock';
/** A migration lock whose holder stopped heart-beating this long ago is broken */
export const MIGRATION_LOCK_STALE_AFTER_MS = 60_000;

export function cronMongoLocks(collection: Collection<any>): LockStore {
  return new MongoLockStore(collection);
}

/** `{ _id: 'initial-admin', claimedAt }` — expired once `claimedAt` is older than the stale period */
export function systemSetupMongoLocks(collection: Collection<any>): LockStore {
  return new MongoLockStore(collection, {
    legacyTimestamp: { field: 'claimedAt', staleAfterMs: SYSTEM_SETUP_CLAIM_STALE_AFTER_MS },
  });
}

/**
 * `{ lock: 'lock', owner, acquiredAt }` with a unique index on `lock` — `acquiredAt` is the holder's heartbeat, and
 * a renewal refreshes it so an older waiter does not break a live lock
 */
export function migrationMongoLocks(collection: Collection<any>): LockStore {
  return new MongoLockStore(collection, {
    keyField: 'lock',
    legacyTimestamp: { field: 'acquiredAt', staleAfterMs: MIGRATION_LOCK_STALE_AFTER_MS },
  });
}

/**
 * The lease store of the default data source when it is a SQL database, its keys prefixed with `namespace` so the
 * consumers sharing the one lease table cannot collide; `undefined` when the default source is MongoDB
 */
export async function defaultSqlLockStore(namespace: string): Promise<LockStore | undefined> {
  const locks = await getPersistenceRuntime()?.defaultLockStore();
  return locks ? namespacedLocks(locks, namespace) : undefined;
}

export function namespacedLocks(locks: LockStore, namespace: string): LockStore {
  const key = (name: string) => `${namespace}:${name}`;
  return {
    release: (name, owner) => locks.release(key(name), owner),
    renew: (name, owner, ttlSeconds) => locks.renew(key(name), owner, ttlSeconds),
    tryAcquire: (name, owner, ttlSeconds) => locks.tryAcquire(key(name), owner, ttlSeconds),
  };
}
