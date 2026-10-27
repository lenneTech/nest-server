import type { Collection } from 'mongodb';

import type { LockStore } from './lock-store.interface.js';

/** The duplicate-key error code, decided by code rather than by matching message text. */
const DUPLICATE_KEY = 11000;

/**
 * Leases in a MongoDB collection: one document per key (`_id`), with `owner` and `expiresAt`.
 *
 * Works on the native collection on purpose — a lease collection has no Mongoose schema and no tenant,
 * audit or password semantics a plugin could add. A TTL index on `expiresAt` may be added for garbage
 * collection; correctness never depends on it, because every claim compares `expiresAt` itself.
 */
export class MongoLockStore implements LockStore {
  constructor(protected readonly collection: Collection<any>) {}

  async release(key: string, owner: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ _id: key, owner });
    return result.deletedCount === 1;
  }

  async renew(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const now = new Date();
    const result = await this.collection.updateOne(
      { _id: key, expiresAt: { $gt: now }, owner },
      { $set: { expiresAt: new Date(now.getTime() + ttlSeconds * 1000) } },
    );
    return result.matchedCount === 1;
  }

  async tryAcquire(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const now = new Date();
    try {
      // Matches only an EXPIRED lease, which is taken over in one atomic step. A held lease does not
      // match, so the upsert tries to insert the same _id and fails with a duplicate key: lost. A missing
      // lease is inserted: won. Two contenders for one expired lease cannot both match — the first update
      // moves expiresAt into the future before the second is evaluated.
      await this.collection.updateOne(
        { _id: key, expiresAt: { $lte: now } },
        { $set: { acquiredAt: now, expiresAt: new Date(now.getTime() + ttlSeconds * 1000), owner } },
        { upsert: true },
      );
      return true;
    } catch (error) {
      if ((error as { code?: number })?.code === DUPLICATE_KEY) {
        return false;
      }
      throw error;
    }
  }
}
