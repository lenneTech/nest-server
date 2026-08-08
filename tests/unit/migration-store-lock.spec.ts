/**
 * Unit Tests: migration lock defaults
 *
 * The lock exists in `MongoStateStore` but used to be inert, because the store built by
 * `createMigrationStore()` carried no `lockCollectionName`. With the container entrypoint
 * running `migrate up` on EVERY boot, N replicas starting together each applied the same
 * pending migration. The default below is what arms the lock; `withMigrationLock()` is
 * what a caller without a lock collection must still pass through unchanged, so a
 * single-replica setup keeps behaving exactly as before.
 */

import { describe, expect, it } from 'vitest';

import { createMigrationStore } from '../../src/core/modules/migrate/helpers/migration.helper';
import { MongoStateStore, withMigrationLock } from '../../src/core/modules/migrate/mongo-state-store';

describe('createMigrationStore', () => {
  it('defaults the lock collection to migrations_lock', () => {
    const Store = createMigrationStore('mongodb://localhost/test');
    const store = new Store();

    expect(store).toBeInstanceOf(MongoStateStore);
    expect(store.lockCollectionName).toBe('migrations_lock');
  });

  it('keeps an explicitly given lock collection name', () => {
    const Store = createMigrationStore('mongodb://localhost/test', 'migrations', 'custom_lock');

    expect(new Store().lockCollectionName).toBe('custom_lock');
  });

  it('disables locking on an empty lock collection name', () => {
    const Store = createMigrationStore('mongodb://localhost/test', 'migrations', '');

    expect(new Store().lockCollectionName).toBeUndefined();
  });
});

describe('withMigrationLock', () => {
  it('runs the callback without touching MongoDB when the store has no lock collection', async () => {
    // An unreachable URI: any lock attempt would fail instead of returning the value.
    const store = new MongoStateStore('mongodb://127.0.0.1:1/unused');

    await expect(withMigrationLock(store, async () => 'ran')).resolves.toBe('ran');
  });
});
