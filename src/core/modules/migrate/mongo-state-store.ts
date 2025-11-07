import { Db, MongoClient } from 'mongodb';
import { promisify } from 'util';

/**
 * Migration options interface (compatible with migrate package)
 */
export interface MigrationOptions {
  [key: string]: unknown;
  stateStore: MongoStateStore;
}

/**
 * Migration set interface (compatible with migrate package)
 */
export interface MigrationSet {
  down?: (done?: (err?: Error) => void) => void;
  lastRun?: string;
  migrations: Array<{ timestamp?: number; title: string }>;
  up: (done?: (err?: Error) => void) => void;
}

/**
 * Options for MongoStateStore configuration
 */
export interface MongoStateStoreOptions {
  /** Name of the collection to store migration state (default: 'migrations') */
  collectionName?: string;
  /**
   * Optionally specify a collection to use for locking. This is intended for
   * clusters with multiple nodes to ensure that not more than one migration
   * can run at any given time. You must use the `synchronizedMigration` or
   * `synchronizedUp` function, instead of triggering the migration via
   * `migrate` directly.
   */
  lockCollectionName?: string;
  /** MongoDB connection URI */
  uri: string;
}

/**
 * MongoDB State Store for migration state management
 *
 * This class provides a MongoDB-based state store for migration frameworks,
 * allowing migration states to be persisted directly in MongoDB instead of
 * in separate files. It supports MongoDB 6+ and provides a locking mechanism
 * for clustered environments.
 *
 * @example
 * ```typescript
 * const stateStore = new MongoStateStore('mongodb://localhost/mydb');
 * // or with options
 * const stateStore = new MongoStateStore({
 *   uri: 'mongodb://localhost/mydb',
 *   collectionName: 'custom_migrations',
 *   lockCollectionName: 'migration_lock'
 * });
 * ```
 */
export class MongoStateStore {
  /** Collection name for storing migration state */
  private readonly collectionName: string;

  /** MongoDB connection URI */
  readonly mongodbHost: string;

  /** Optional collection name for locking mechanism */
  readonly lockCollectionName?: string;

  /**
   * Creates a new MongoStateStore instance
   *
   * @param objectOrHost - MongoDB URI string or configuration object
   */
  constructor(objectOrHost: MongoStateStoreOptions | string) {
    this.mongodbHost = typeof objectOrHost === 'string' ? objectOrHost : objectOrHost.uri;
    this.collectionName =
      typeof objectOrHost === 'string' ? 'migrations' : (objectOrHost.collectionName ?? 'migrations');
    this.lockCollectionName = typeof objectOrHost !== 'string' ? objectOrHost.lockCollectionName : undefined;
  }

  /**
   * Loads the migration state from MongoDB
   *
   * @param fn - Callback function receiving error or migration set
   */
  load(fn: (err?: Error, set?: MigrationSet) => void): void {
    this.loadAsync()
      .then((result) => fn(undefined, result))
      .catch((err) => fn(err));
  }

  /**
   * Loads the migration state from MongoDB (async version)
   *
   * @returns Promise with migration set
   */
  async loadAsync(): Promise<MigrationSet> {
    return dbRequest(this.mongodbHost, async (db) => {
      const result = await db.collection(this.collectionName).find({}).toArray();

      if (result.length > 1) {
        throw new Error(`Expected exactly one result, but got ${result.length}`);
      }

      if (result.length === 0) {
        console.debug('No migrations found, probably running the very first time');
        // Return empty object for compatibility with @nodepit/migrate-state-store-mongodb
        return {} as MigrationSet;
      }

      return result[0] as unknown as MigrationSet;
    });
  }

  /**
   * Saves the migration state to MongoDB
   *
   * @param set - Migration set to save
   * @param fn - Callback function receiving optional error
   */
  save(set: MigrationSet, fn: (err?: Error) => void): void {
    this.saveAsync(set)
      .then(() => fn())
      .catch((err) => fn(err));
  }

  /**
   * Saves the migration state to MongoDB (async version)
   *
   * @param set - Migration set to save
   */
  async saveAsync(set: MigrationSet): Promise<void> {
    const { lastRun, migrations } = set;
    await dbRequest(this.mongodbHost, async (db) => {
      await db.collection(this.collectionName).replaceOne({}, { lastRun, migrations }, { upsert: true });
    });
  }
}

/**
 * Wraps migrations with a lock to prevent simultaneous execution in clustered environments
 *
 * This function ensures that only one instance can run migrations at a time by using
 * a MongoDB-based locking mechanism. To use this functionality, you must set the
 * `lockCollectionName` in the `MongoStateStore` options.
 *
 * @param opts - Migration options including state store
 * @param callback - Callback function that receives the migration set
 * @throws Error if state store is not configured correctly
 *
 * @example
 * ```typescript
 * await synchronizedMigration({
 *   stateStore: new MongoStateStore({
 *     uri: 'mongodb://localhost/db',
 *     lockCollectionName: 'migrationlock'
 *   })
 * }, async (migrationSet) => {
 *   // Only one instance at a time will execute this
 *   await promisify(migrationSet.up).call(migrationSet);
 * });
 * ```
 */
export async function synchronizedMigration(
  opts: MigrationOptions,
  callback: (set: MigrationSet) => Promise<void>,
): Promise<void> {
  if (!opts.stateStore) {
    throw new Error('No `stateStore` in migration options');
  }

  const stateStore = opts.stateStore;

  if (!(stateStore instanceof MongoStateStore)) {
    throw new Error('Given `stateStore` is not `MongoStateStore`');
  }

  const lockCollectionName = stateStore.lockCollectionName;

  if (typeof lockCollectionName !== 'string') {
    throw new Error('`lockCollectionName` in MongoStateStore is not set');
  }

  try {
    await acquireLock(stateStore.mongodbHost, lockCollectionName);

    // Load migration set using async method
    const set = await stateStore.loadAsync();
    await callback(set);
  } finally {
    await releaseLock(stateStore.mongodbHost, lockCollectionName);
  }
}

/**
 * Executes all pending migrations in a synchronized manner (for clustered environments)
 *
 * This is a convenience function that wraps `synchronizedMigration` and automatically
 * calls the `up` method on the migration set.
 *
 * @param opts - Migration options including state store
 * @throws Error if state store is not configured correctly
 *
 * @example
 * ```typescript
 * await synchronizedUp({
 *   stateStore: new MongoStateStore({
 *     uri: 'mongodb://localhost/db',
 *     lockCollectionName: 'migrationlock'
 *   })
 * });
 * ```
 */
export async function synchronizedUp(opts: MigrationOptions): Promise<void> {
  await synchronizedMigration(opts, async (loadedSet) => {
    await promisify(loadedSet.up).call(loadedSet);
  });
}

/**
 * Acquires a lock in MongoDB to ensure only one migration runs at a time
 *
 * @param url - MongoDB connection URI
 * @param lockCollectionName - Name of the collection to use for locking
 */
async function acquireLock(url: string, lockCollectionName: string): Promise<void> {
  await dbRequest(url, async (db) => {
    const collection = db.collection(lockCollectionName);

    // Create unique index for atomicity
    // https://docs.mongodb.com/manual/reference/method/db.collection.update/#use-unique-indexes
    // https://groups.google.com/forum/#!topic/mongodb-user/-fucdS-7kIU
    // https://stackoverflow.com/questions/33346175/mongodb-upsert-operation-seems-not-atomic-which-throws-duplicatekeyexception/34784533
    await collection.createIndex({ lock: 1 }, { unique: true });

    let showMessage = true;

    for (;;) {
      // Use updateOne with upsert for atomic lock acquisition (same as original package)
      const result = await collection.updateOne({ lock: 'lock' }, { $set: { lock: 'lock' } }, { upsert: true });
      const lockAcquired = result.upsertedCount > 0;

      if (lockAcquired) {
        break;
      }

      if (showMessage) {
        console.debug('Waiting for migration lock release …');
        showMessage = false;
      }

      await promisify(setTimeout)(100);
    }
  });
}

/**
 * Executes database operations with automatic connection management
 *
 * @param url - MongoDB connection URI
 * @param callback - Callback function to execute with database instance
 * @returns Promise with callback result
 */
async function dbRequest<T>(url: string, callback: (db: Db) => Promise<T> | T): Promise<T> {
  let client: MongoClient | undefined;
  try {
    client = await MongoClient.connect(url);
    const db = client.db();
    return await callback(db);
  } finally {
    await client?.close();
  }
}

/**
 * Releases a migration lock in MongoDB
 *
 * @param url - MongoDB connection URI
 * @param lockCollectionName - Name of the collection used for locking
 */
async function releaseLock(url: string, lockCollectionName: string): Promise<void> {
  await dbRequest(url, (db) => db.collection(lockCollectionName).deleteOne({ lock: 'lock' }));
}
