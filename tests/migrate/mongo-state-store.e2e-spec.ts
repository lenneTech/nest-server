/**
 * E2E tests for MongoDB State Store migration functionality
 *
 * These tests verify the complete migration state storage system including:
 * - State store initialization and configuration
 * - Loading and saving migration state
 * - Locking mechanism for cluster environments
 * - Backward compatibility with @nodepit/migrate-state-store-mongodb
 * - MongoDB 7.x compatibility
 *
 * @important Test Cleanup
 * All test collections are automatically cleaned up:
 * - Before all tests (beforeAll)
 * - Before each test (beforeEach)
 * - After all tests (afterAll) - including dropping collections with indexes
 *
 * This ensures:
 * 1. Tests start with a clean database
 * 2. Tests don't interfere with each other
 * 3. No test data remains in the database after test completion
 * 4. Even if tests fail, cleanup still occurs (try-catch blocks)
 */

import * as fs from 'fs';
import { MongoClient } from 'mongodb';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import {
  createMigrationStore,
  MigrationOptions,
  MigrationRunner,
  MongoStateStore,
  synchronizedMigration,
} from '../../src';
import { deriveTestDbUri } from '../db-lifecycle.reporter';

describe('MongoDB State Store for Migrations (e2e)', () => {
  // NEVER default to nest-server-local here — that is the developer's LOCAL DEV
  // database, and this suite manipulates its `migrations` collection.
  const mongoUrl = process.env.MONGODB_URL || deriveTestDbUri('migrate');
  const defaultCollectionName = 'migrations';

  // List of all collections used in tests for comprehensive cleanup
  const testCollections = [
    'migrations',
    'migration_lock',
    'test_migration_collection',
    'custom_migrations_test',
    'custom_migrations_save_test',
    'test_lock_collection',
    'concurrent_migrations',
    'concurrent_migrations_lock',
  ];

  const migrationDoc = {
    lastRun: '1587915479438-my-migration.js',
    migrations: [
      {
        description: null,
        timestamp: 1587919095301.0,
        title: '1587915479438-my-migration.js',
      },
    ],
  };

  let client: MongoClient;

  /**
   * Helper function to clean up all test collections
   */
  const cleanupAllCollections = async () => {
    for (const collectionName of testCollections) {
      try {
        await client.db().collection(collectionName).deleteMany({});
      } catch (error) {
        // Ignore errors if collection doesn't exist
      }
    }
  };

  beforeAll(async () => {
    client = await MongoClient.connect(mongoUrl);
    // Clean up before starting tests
    await cleanupAllCollections();
  });

  beforeEach(async () => {
    // Clean up test collections before each test
    await cleanupAllCollections();
  });

  afterAll(async () => {
    // Final comprehensive cleanup - ensure nothing is left behind
    await cleanupAllCollections();

    // Optional: Drop collections entirely to clean up indexes too
    for (const collectionName of testCollections) {
      try {
        await client.db().collection(collectionName).drop();
      } catch (error) {
        // Ignore errors if collection doesn't exist
      }
    }

    await client.close();
  });

  describe('MongoStateStore Initialization', () => {
    it('should be instantiated with a simple string URI', () => {
      const stateStore = new MongoStateStore('mongodb://localhost/test');
      expect(stateStore).toBeInstanceOf(MongoStateStore);
      expect(stateStore.mongodbHost).toBe('mongodb://localhost/test');
    });

    it('should be instantiated with an options object', () => {
      const stateStore = new MongoStateStore({
        collectionName: 'custom_migrations',
        uri: 'mongodb://localhost/test',
      });
      expect(stateStore).toBeInstanceOf(MongoStateStore);
      expect(stateStore.mongodbHost).toBe('mongodb://localhost/test');
    });

    it('should use default collection name when not specified', () => {
      const stateStore = new MongoStateStore(mongoUrl);
      expect(stateStore).toBeInstanceOf(MongoStateStore);
    });

    it('should accept lockCollectionName in options', () => {
      const stateStore = new MongoStateStore({
        lockCollectionName: 'migration_lock',
        uri: mongoUrl,
      });
      expect(stateStore.lockCollectionName).toBe('migration_lock');
    });
  });

  describe('Error Handling', () => {
    it('should handle connection errors gracefully', async () => {
      const stateStore = new MongoStateStore('mongodb://127.0.0.1:27018/test?serverSelectionTimeoutMS=1000');

      try {
        await stateStore.loadAsync();
        throw new Error('Should have thrown an error');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }
    }, 10000);
  });

  describe('Loading State', () => {
    it('should throw error when migrations collection contains more than one document', async () => {
      // Insert two documents to trigger error
      await client
        .db()
        .collection(defaultCollectionName)
        .insertOne({ ...migrationDoc });
      await client
        .db()
        .collection(defaultCollectionName)
        .insertOne({ ...migrationDoc });

      const stateStore = new MongoStateStore(mongoUrl);

      try {
        await stateStore.loadAsync();
        throw new Error('Should have thrown an error');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe('Expected exactly one result, but got 2');
      }
    });

    it('should return empty object when collection is empty', async () => {
      const stateStore = new MongoStateStore(mongoUrl);
      const result = await stateStore.loadAsync();
      // Must return empty object {} for compatibility with @nodepit/migrate-state-store-mongodb
      expect(result).toEqual({});
    });

    it('should return migrations document using callback API', async () => {
      await client
        .db()
        .collection(defaultCollectionName)
        .insertOne({ ...migrationDoc });

      const stateStore = new MongoStateStore(mongoUrl);
      const loadPromise = promisify(stateStore.load.bind(stateStore));
      const result = await loadPromise();

      expect(result).toMatchObject(migrationDoc);
    });

    it('should return migrations document using async API', async () => {
      await client
        .db()
        .collection(defaultCollectionName)
        .insertOne({ ...migrationDoc });

      const stateStore = new MongoStateStore(mongoUrl);
      const result = await stateStore.loadAsync();

      expect(result).toMatchObject(migrationDoc);
    });

    it('should return migrations document from custom collection', async () => {
      const customCollectionName = 'custom_migrations_test';
      const customMigrationDoc = {
        ...migrationDoc,
        lastRun: `${new Date().getTime()}-my-migration.js`,
      };

      await client
        .db()
        .collection(customCollectionName)
        .insertOne({ ...customMigrationDoc });

      const stateStore = new MongoStateStore({
        collectionName: customCollectionName,
        uri: mongoUrl,
      });

      const result = await stateStore.loadAsync();
      expect(result).toMatchObject(customMigrationDoc);

      // Cleanup
      await client.db().collection(customCollectionName).deleteMany({});
    });
  });

  describe('Saving State', () => {
    it('should insert new document into empty migrations collection', async () => {
      const stateStore = new MongoStateStore(mongoUrl);
      await stateStore.saveAsync(migrationDoc as any);

      const docs = await client.db().collection(defaultCollectionName).find({}).toArray();
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject(migrationDoc);
    });

    it('should save using callback API', async () => {
      const stateStore = new MongoStateStore(mongoUrl);
      const savePromise = promisify(stateStore.save.bind(stateStore));
      await savePromise(migrationDoc as any);

      const docs = await client.db().collection(defaultCollectionName).find({}).toArray();

      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject(migrationDoc);
    });

    it('should insert new document into custom migrations collection', async () => {
      const customCollectionName = 'custom_migrations_save_test';
      const stateStore = new MongoStateStore({
        collectionName: customCollectionName,
        uri: mongoUrl,
      });

      await stateStore.saveAsync(migrationDoc as any);

      const docs = await client.db().collection(customCollectionName).find({}).toArray();
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject(migrationDoc);

      // Cleanup
      await client.db().collection(customCollectionName).deleteMany({});
    });

    it('should replace existing document in migrations collection', async () => {
      // Insert an empty document first
      await client.db().collection(defaultCollectionName).insertOne({ oldData: true });

      const stateStore = new MongoStateStore(mongoUrl);
      await stateStore.saveAsync(migrationDoc as any);

      const docs = await client.db().collection(defaultCollectionName).find({}).toArray();
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject(migrationDoc);
      expect((docs[0] as any).oldData).toBeUndefined();
    });
  });

  describe('Locking Mechanism', () => {
    const collectionName = 'migrations';
    const lockCollectionName = 'migration_lock';
    const testCollectionName = 'test_migration_collection';

    beforeEach(async () => {
      await client.db().collection(collectionName).deleteMany({});
      await client.db().collection(lockCollectionName).deleteMany({});
      await client.db().collection(testCollectionName).deleteMany({});
    });

    it('should create lock entry in database during migration', async () => {
      const migrationOptions: MigrationOptions = {
        stateStore: new MongoStateStore({
          collectionName,
          lockCollectionName,
          uri: mongoUrl,
        }),
      };

      let numDocsInLockCollection: number | undefined;

      await synchronizedMigration(migrationOptions, async () => {
        // Lock collection should have exactly one entry during migration
        numDocsInLockCollection = await client.db().collection(lockCollectionName).countDocuments();
      });

      expect(numDocsInLockCollection).toBe(1);
    });

    it('should delete lock entry after migration completes', async () => {
      const migrationOptions: MigrationOptions = {
        stateStore: new MongoStateStore({
          collectionName,
          lockCollectionName,
          uri: mongoUrl,
        }),
      };

      await synchronizedMigration(migrationOptions, async () => {
        // Migration logic here
      });

      // Lock collection should be empty after migration
      const numDocsInLockCollection = await client.db().collection(lockCollectionName).countDocuments();
      expect(numDocsInLockCollection).toBe(0);
    });

    it('should properly release lock when running sequentially', async () => {
      const migrationOptions: MigrationOptions = {
        stateStore: new MongoStateStore({
          collectionName,
          lockCollectionName,
          uri: mongoUrl,
        }),
      };

      // Simulate multiple sequential migration runs
      let counter = 0;
      for (let i = 0; i < 5; i++) {
        await synchronizedMigration(migrationOptions, async () => {
          counter++;
        });
      }

      expect(counter).toBe(5);

      // Lock should be released
      const numDocsInLockCollection = await client.db().collection(lockCollectionName).countDocuments();
      expect(numDocsInLockCollection).toBe(0);
    }, 30000);

    it('should properly handle lock when running in parallel', async () => {
      const migrationOptions: MigrationOptions = {
        stateStore: new MongoStateStore({
          collectionName,
          lockCollectionName,
          uri: mongoUrl,
        }),
      };

      let executionCount = 0;
      const promises: Promise<void>[] = [];

      // Simulate multiple parallel migration attempts
      for (let i = 0; i < 10; i++) {
        promises.push(
          synchronizedMigration(migrationOptions, async () => {
            executionCount++;
            // Simulate some async work
            await promisify(setTimeout)(100);
          }),
        );
      }

      await Promise.all(promises);

      expect(executionCount).toBe(10);

      // Lock should be released after all migrations
      const numDocsInLockCollection = await client.db().collection(lockCollectionName).countDocuments();
      expect(numDocsInLockCollection).toBe(0);
    }, 30000);
  });

  describe('Concurrent migrate up (multi-replica)', () => {
    const collectionName = 'concurrent_migrations';
    const lockCollectionName = 'concurrent_migrations_lock';

    let dir: string;

    /**
     * Migration fixture that records every execution and stays busy long enough for a
     * second, unsynchronized runner to load the still-empty state and start it as well.
     */
    const writeSlowMigration = (marker: string) => {
      fs.writeFileSync(
        path.join(dir, '1699000000001-concurrent.js'),
        `module.exports.up = async () => {
          require('fs').appendFileSync(${JSON.stringify(marker)}, 'up\\n');
          await new Promise((resolve) => setTimeout(resolve, 300));
        };\n`,
      );
    };

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-concurrent-'));
    });

    afterEach(() => {
      fs.rmSync(dir, { force: true, recursive: true });
    });

    it('applies a pending migration exactly once when two replicas run up() at the same time', async () => {
      const marker = path.join(dir, 'executions.marker');
      writeSlowMigration(marker);

      // Two independent stores, exactly as two replicas would build them from config.
      const Store = createMigrationStore(mongoUrl, collectionName, lockCollectionName);
      const runners = [new Store(), new Store()].map(
        (stateStore) => new MigrationRunner({ migrationsDirectory: dir, stateStore }),
      );

      await Promise.all(runners.map((runner) => runner.up()));

      // Without the lock, both runners read the empty state and apply the migration.
      expect(fs.readFileSync(marker, 'utf-8')).toBe('up\n');

      const state = await client.db().collection(collectionName).find({}).toArray();
      expect(state).toHaveLength(1);
      expect((state[0] as any).migrations.map((m: any) => m.title)).toEqual(['1699000000001-concurrent.js']);

      // Lock released by both runners
      expect(await client.db().collection(lockCollectionName).countDocuments()).toBe(0);
    }, 30000);

    it('breaks a lock whose holder died instead of blocking the boot forever', async () => {
      // Migrations run on EVERY container boot, so a replica SIGKILLed mid-migration
      // (OOM, node drain, failed deploy) leaves a lock document nobody holds and no
      // `finally` ever releases. Before the heartbeat + break, acquireLock() spun in an
      // unbounded loop on it: every future boot of every replica hung, and the whole
      // service could not start again without manual database surgery.
      const marker = path.join(dir, 'executions.marker');
      writeSlowMigration(marker);

      // A lock left behind by a process that is gone: last heartbeat well past the
      // staleness window, and nothing refreshing it.
      await client
        .db()
        .collection(lockCollectionName)
        .insertOne({
          acquiredAt: new Date(Date.now() - 10 * 60_000),
          lock: 'lock',
          owner: 'dead-replica:1',
        });

      const Store = createMigrationStore(mongoUrl, collectionName, lockCollectionName);
      const runner = new MigrationRunner({ migrationsDirectory: dir, stateStore: new Store() });

      await runner.up();

      // The migration ran, and the run released its own lock afterwards
      expect(fs.readFileSync(marker, 'utf-8')).toBe('up\n');
      expect(await client.db().collection(lockCollectionName).countDocuments()).toBe(0);
    }, 30000);

    it('leaves a freshly held lock alone', async () => {
      // The mirror image of the test above: a lock that IS being heart-beaten must never
      // be broken, otherwise "recover from a dead holder" would silently become "run two
      // migrations at once" — strictly worse than the deadlock it replaced.
      const marker = path.join(dir, 'executions.marker');
      writeSlowMigration(marker);

      await client
        .db()
        .collection(lockCollectionName)
        .insertOne({ acquiredAt: new Date(), lock: 'lock', owner: 'live-replica:1' });

      const Store = createMigrationStore(mongoUrl, collectionName, lockCollectionName);
      const runner = new MigrationRunner({ migrationsDirectory: dir, stateStore: new Store() });

      // Still waiting on the live holder when the window closes — so no migration ran.
      const finished = await Promise.race([
        runner.up().then(() => 'finished'),
        new Promise(resolve => setTimeout(() => resolve('still-waiting'), 1500)),
      ]);

      expect(finished).toBe('still-waiting');
      expect(fs.existsSync(marker)).toBe(false);

      // Release it so the pending runner can finish and not leak into the next test
      await client.db().collection(lockCollectionName).deleteMany({});
    }, 30000);
  });

  describe('Parameter Validation', () => {
    it('should throw if migration options has no stateStore', async () => {
      await expect(synchronizedMigration({} as any, () => Promise.resolve())).rejects.toThrow(
        'No `stateStore` in migration options',
      );
    });

    it('should throw if stateStore is not a MongoStateStore', async () => {
      await expect(synchronizedMigration({ stateStore: 'migrations' } as any, () => Promise.resolve())).rejects.toThrow(
        'Given `stateStore` is not `MongoStateStore`',
      );
    });

    it('should throw if lockCollectionName is not set', async () => {
      await expect(
        synchronizedMigration({ stateStore: new MongoStateStore(mongoUrl) }, () => Promise.resolve()),
      ).rejects.toThrow('`lockCollectionName` in MongoStateStore is not set');
    });
  });

  describe('Backward Compatibility', () => {
    it('should be compatible with @nodepit/migrate-state-store-mongodb API', () => {
      // Test that the API matches the original package
      const stateStore = new MongoStateStore({
        collectionName: 'migrations',
        lockCollectionName: 'migration_lock',
        uri: mongoUrl,
      });

      // Check that all expected properties and methods exist
      expect(stateStore.mongodbHost).toBeDefined();
      expect(stateStore.lockCollectionName).toBeDefined();
      expect(typeof stateStore.load).toBe('function');
      expect(typeof stateStore.save).toBe('function');
      expect(typeof stateStore.loadAsync).toBe('function');
      expect(typeof stateStore.saveAsync).toBe('function');
    });

    it('should support both callback and promise-based APIs', async () => {
      const stateStore = new MongoStateStore(mongoUrl);

      // Test callback API
      const callbackResult = await new Promise((resolve, reject) => {
        stateStore.load((err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        });
      });

      expect(callbackResult).toBeDefined();

      // Test promise API
      const promiseResult = await stateStore.loadAsync();
      expect(promiseResult).toBeDefined();
    });
  });

  describe('MongoDB 7.x Compatibility', () => {
    it('should work with MongoDB 7.x operations', async () => {
      const stateStore = new MongoStateStore(mongoUrl);

      // Test save and load operations that use MongoDB 7.x features
      await stateStore.saveAsync(migrationDoc as any);

      const loaded = await stateStore.loadAsync();
      expect(loaded).toMatchObject(migrationDoc);

      // Test that replaceOne with upsert works (MongoDB 7.x feature)
      const updatedDoc = {
        ...migrationDoc,
        lastRun: 'updated-migration.js',
      };

      await stateStore.saveAsync(updatedDoc as any);

      const docs = await client.db().collection(defaultCollectionName).find({}).toArray();
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject(updatedDoc);
    });

    it('should handle unique index creation for locking (MongoDB 7.x)', async () => {
      const lockCollectionName = 'test_lock_collection';
      const migrationOptions: MigrationOptions = {
        stateStore: new MongoStateStore({
          collectionName: 'migrations',
          lockCollectionName,
          uri: mongoUrl,
        }),
      };

      await synchronizedMigration(migrationOptions, async () => {
        // Check that unique index was created
        const indexes = await client.db().collection(lockCollectionName).indexes();
        const lockIndex = indexes.find((idx) => idx.key && idx.key.lock === 1);
        expect(lockIndex).toBeDefined();
        expect(lockIndex?.unique).toBe(true);
      });

      // Cleanup
      await client
        .db()
        .collection(lockCollectionName)
        .drop()
        .catch(() => {
          // Ignore errors if collection doesn't exist
        });
    });
  });
});
