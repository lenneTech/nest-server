import type { DataStore, StoredRecord, Where } from './data-store.interface.js';

/**
 * Set fields on the record matching `where`, or create it — MongoDB's `updateOne(…, { upsert: true })` on any store.
 *
 * The store port has no upsert of its own (an `INSERT … ON CONFLICT` needs the conflict target, which only the caller
 * knows), so this composes it: an atomic `updateOne`, and an `insert` when nothing matched. `where` must name a unique
 * key of the model — that index is what turns a concurrent second insert into a duplicate-key error, after which the
 * record exists and the update is applied to it.
 *
 * `onInsert` are fields only a new record gets (MongoDB's `$setOnInsert`).
 */
export async function upsertRecord<T>(
  store: DataStore<T>,
  where: Where<T> & Record<string, unknown>,
  set: Record<string, unknown>,
  onInsert: Record<string, unknown> = {},
): Promise<StoredRecord<T>> {
  const updated = await store.updateOne(where, { $set: set } as any);
  if (updated) {
    return updated;
  }
  try {
    return await store.insert({ ...where, ...onInsert, ...set } as any);
  } catch (error) {
    if ((error as { code?: unknown })?.code !== 11000) {
      throw error;
    }
    // Another caller created it between the two steps: it exists now
    const retried = await store.updateOne(where, { $set: set } as any);
    if (!retried) {
      throw error;
    }
    return retried;
  }
}
