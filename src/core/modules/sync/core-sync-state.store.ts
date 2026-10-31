import type { DataStore } from '../../common/persistence/data-store.interface.js';
import { isDuplicateKey } from './core-sync-mutation.store.js';

interface StateRecord {
  epoch?: null | number;
  horizon?: Date | null;
  key: string;
}

/**
 * Access epochs and tombstone horizons (offline-sync plan §3.7, §3.8), keyed by string:
 *
 * - `epoch:t:<model>:<tenant>` — bumped when what a tenant's members may see changes (`invalidateTenant()`, a record
 *   moved to another tenant). A cursor carries the epochs it was issued under; another value answers 410 `access`.
 * - `epoch:u:<model>:<tenant>:<user>` — bumped when a scope field (`sync.scope`) changes away from that user, so only
 *   that user's cursors resync.
 * - `horizon:<model>` — the oldest point a cursor may continue from; a cursor whose state is older answers 410 `horizon`.
 *
 * A bump is one atomic increment; a key that does not exist yet is created with a duplicate-key retry, so two
 * concurrent bumps both count.
 */
export class CoreSyncStateStore {
  constructor(protected readonly store: DataStore<StateRecord>) {}

  static tenantEpochKey(model: string, tenantId: string): string {
    return `epoch:t:${model}:${tenantId}`;
  }

  static userEpochKey(model: string, tenantId: string, userId: string): string {
    return `epoch:u:${model}:${tenantId}:${userId}`;
  }

  static horizonKey(model: string): string {
    return `horizon:${model}`;
  }

  /** The current epochs of `keys`; a key never bumped is `0` */
  async epochs(keys: readonly string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>(keys.map((key) => [key, 0]));
    if (!keys.length) {
      return result;
    }
    for (const row of await this.store.find({ key: { $in: [...keys] } }, { select: ['epoch', 'key'] })) {
      result.set(row.key, typeof row.epoch === 'number' ? row.epoch : 0);
    }
    return result;
  }

  async bump(key: string): Promise<void> {
    if (await this.store.updateOne({ key }, { $inc: { epoch: 1 } })) {
      return;
    }
    try {
      await this.store.insert({ epoch: 1, key });
    } catch (error) {
      if (!isDuplicateKey(error)) {
        throw error;
      }
      // Created concurrently: this bump still counts
      await this.store.updateOne({ key }, { $inc: { epoch: 1 } });
    }
  }

  /** The tombstone horizon of a model, `undefined` while no purge ran */
  async horizon(model: string): Promise<Date | undefined> {
    const row = await this.store.findOne({ key: CoreSyncStateStore.horizonKey(model) });
    return row?.horizon ? new Date(row.horizon) : undefined;
  }

  /** Move the horizon forward to `at` — never back, so a slower purge cannot reopen a gap a faster one closed */
  async advanceHorizon(model: string, at: Date): Promise<void> {
    const key = CoreSyncStateStore.horizonKey(model);
    const behind = { $or: [{ horizon: null }, { horizon: { $lt: at } }], key };
    if (await this.store.updateOne(behind, { $set: { horizon: at } })) {
      return;
    }
    if (await this.store.findOne({ key })) {
      return;
    }
    try {
      await this.store.insert({ horizon: at, key });
    } catch (error) {
      if (!isDuplicateKey(error)) {
        throw error;
      }
      await this.store.updateOne(behind, { $set: { horizon: at } });
    }
  }
}
