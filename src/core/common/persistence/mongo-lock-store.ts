import type { Collection } from 'mongodb';

import type { LockStore } from './lock-store.interface.js';

/** The duplicate-key error code, decided by code rather than by matching message text. */
const DUPLICATE_KEY = 11000;

export interface MongoLockStoreOptions {
  /**
   * Field holding the lease key — `_id` by default. Any other field gets a unique index before the first claim: the
   * claim's atomicity rests on it, exactly as it rests on `_id` otherwise.
   */
  keyField?: string;
  /**
   * A lock format older versions wrote: a timestamp and no `expiresAt`. Such a lock counts as expired once the
   * timestamp is older than `staleAfterMs` — the rule those versions apply themselves — and every lock this store
   * writes or renews carries the timestamp too, so an older replica applies its rule to it in a rolling deploy. Both
   * sides then decide on one document, and a lease is never held twice.
   */
  legacyTimestamp?: { field: string; staleAfterMs: number };
}

/**
 * Leases in a MongoDB collection: one document per key (`_id` by default), with `owner` and `expiresAt`.
 *
 * Works on the native collection on purpose — a lease collection has no Mongoose schema and no tenant,
 * audit or password semantics a plugin could add. A TTL index on `expiresAt` may be added for garbage
 * collection; correctness never depends on it, because every claim compares `expiresAt` itself.
 */
export class MongoLockStore implements LockStore {
  protected readonly keyField: string;
  private keyIndex?: Promise<unknown>;

  constructor(
    protected readonly collection: Collection<any>,
    protected readonly options: MongoLockStoreOptions = {},
  ) {
    this.keyField = options.keyField ?? '_id';
  }

  async release(key: string, owner: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ [this.keyField]: key, owner });
    return result.deletedCount === 1;
  }

  async renew(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const now = new Date();
    const result = await this.collection.updateOne(
      { [this.keyField]: key, expiresAt: { $gt: now }, owner },
      { $set: { ...this.legacyStamp(now), expiresAt: new Date(now.getTime() + ttlSeconds * 1000) } },
    );
    return result.matchedCount === 1;
  }

  async tryAcquire(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    await this.ensureKeyIndex();
    const now = new Date();
    const legacy = this.options.legacyTimestamp;
    // Matches only an EXPIRED lease, which is taken over in one atomic step. A held lease does not
    // match, so the upsert tries to insert the same key and fails with a duplicate key: lost. A missing
    // lease is inserted: won. Two contenders for one expired lease cannot both match — the first update
    // moves expiresAt into the future before the second is evaluated.
    const expired = legacy
      ? {
          $or: [
            { expiresAt: { $lte: now } },
            {
              expiresAt: { $exists: false },
              [legacy.field]: { $lt: new Date(now.getTime() - legacy.staleAfterMs) },
            },
          ],
        }
      : { expiresAt: { $lte: now } };
    try {
      await this.collection.updateOne(
        { [this.keyField]: key, ...expired },
        {
          $set: {
            ...(this.keyField === '_id' ? {} : { [this.keyField]: key }),
            ...this.legacyStamp(now),
            acquiredAt: now,
            expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
            owner,
          },
        },
        { upsert: true },
      );
      return true;
    } catch (error) {
      if ((error as { code?: number })?.code !== DUPLICATE_KEY) {
        throw error;
      }
      if (legacy) {
        // A lock of a version that wrote no timestamp at all: start its clock now — as those versions did — rather
        // than obeying it forever or breaking it at once (its holder may well be alive)
        await this.collection.updateOne(
          { [this.keyField]: key, expiresAt: { $exists: false }, [legacy.field]: { $exists: false } },
          { $set: { [legacy.field]: now } },
        );
      }
      return false;
    }
  }

  /** The timestamp older versions read, refreshed with every claim and renewal */
  private legacyStamp(now: Date): Record<string, Date> {
    return this.options.legacyTimestamp ? { [this.options.legacyTimestamp.field]: now } : {};
  }

  private async ensureKeyIndex(): Promise<void> {
    if (this.keyField === '_id') {
      return;
    }
    this.keyIndex ??= this.collection.createIndex({ [this.keyField]: 1 }, { unique: true }).catch((error) => {
      // Retried on the next claim: without the index a second contender could insert a second lock
      this.keyIndex = undefined;
      throw error;
    });
    await this.keyIndex;
  }
}
