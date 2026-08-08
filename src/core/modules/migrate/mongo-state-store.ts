import { Db, MongoClient } from 'mongodb';
import { hostname } from 'os';
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
 * Runs `fn` while holding the migration lock of the given state store
 *
 * When the store has no `lockCollectionName`, `fn` runs unsynchronized — a single
 * replica keeps behaving exactly as before. Stores built by `createMigrationStore()`
 * carry the default lock collection, so concurrent `migrate up` runs from several
 * replicas serialize here: the second replica waits, then re-reads the migration
 * state and finds nothing pending.
 *
 * @param stateStore - State store holding the connection URI and lock collection name
 * @param fn - Work to execute under the lock
 * @returns Promise with the result of `fn`
 */
export async function withMigrationLock<T>(stateStore: MongoStateStore, fn: () => Promise<T>): Promise<T> {
  const lockCollectionName = stateStore.lockCollectionName;

  if (!lockCollectionName) {
    return fn();
  }

  await acquireLock(stateStore.mongodbHost, lockCollectionName);
  const heartbeat = startLockHeartbeat(stateStore.mongodbHost, lockCollectionName);
  try {
    return await fn();
  } finally {
    heartbeat.stop();
    await releaseLock(stateStore.mongodbHost, lockCollectionName);
  }
}

/**
 * How long a lock may go without a heartbeat before another replica may break it.
 *
 * Only a lock whose holder stopped refreshing it is ever broken, so this is not a cap
 * on migration runtime — a migration running for hours keeps its lock as long as the
 * process lives.
 */
const LOCK_STALE_AFTER_MS = 60_000;

/** Heartbeat interval — comfortably below {@link LOCK_STALE_AFTER_MS} */
const LOCK_HEARTBEAT_INTERVAL_MS = 15_000;

/** How long a replica waits for a held lock before giving up with a diagnosable error */
const LOCK_WAIT_TIMEOUT_MS = 15 * 60_000;

/**
 * Keep refreshing `acquiredAt` while the migration runs.
 *
 * This is what makes lock-breaking safe: a lock is only ever taken over when its holder
 * stopped refreshing it, which for a live process cannot happen. Without the heartbeat,
 * breaking a stale lock and a long-running migration would be indistinguishable.
 */
function startLockHeartbeat(url: string, lockCollectionName: string): { stop: () => void } {
  const timer = setInterval(() => {
    dbRequest(url, db =>
      db.collection(lockCollectionName).updateOne({ lock: 'lock' }, { $set: { acquiredAt: new Date() } }),
    ).catch((error) => {
      // A missed heartbeat is not fatal on its own — the next one may succeed, and only
      // a sustained gap makes the lock breakable.
      console.warn(`Migration lock heartbeat failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    });
  }, LOCK_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
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

    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    let showMessage = true;

    for (;;) {
      // Use updateOne with upsert for atomic lock acquisition (same as original package).
      // `$setOnInsert` stamps the acquisition time only for the winner, so a loser's
      // update never refreshes the holder's staleness clock.
      const result = await collection.updateOne(
        { lock: 'lock' },
        { $set: { lock: 'lock' }, $setOnInsert: { acquiredAt: new Date(), owner: lockOwnerId() } },
        { upsert: true },
      );

      if (result.upsertedCount > 0) {
        return;
      }

      // The holder may be gone: migrations run on every container boot, so a replica
      // SIGKILLed mid-migration (OOM, node drain, failed deploy) would otherwise leave a
      // lock nobody holds — and every future boot of every replica would wait on it
      // forever. Only a lock that stopped heart-beating is broken; see LOCK_STALE_AFTER_MS.
      const holder = await collection.findOne({ lock: 'lock' });
      if (holder) {
        const acquiredAt = holder.acquiredAt instanceof Date ? holder.acquiredAt : undefined;
        if (!acquiredAt) {
          // Written by a version that did not stamp the lock. Start its clock now rather
          // than breaking it immediately — the holder may well be alive.
          await collection.updateOne(
            { _id: holder._id, acquiredAt: { $exists: false } },
            { $set: { acquiredAt: new Date() } },
          );
        } else if (Date.now() - acquiredAt.getTime() > LOCK_STALE_AFTER_MS) {
          console.warn(
            `Breaking stale migration lock in "${lockCollectionName}" (last heartbeat ${acquiredAt.toISOString()}, `
            + `owner ${holder.owner ?? 'unknown'}) — its holder is gone.`,
          );
          // Matching on acquiredAt makes the break safe under concurrency: if another
          // waiter already broke and re-acquired the lock, the timestamp differs and this
          // deletes nothing.
          await collection.deleteOne({ _id: holder._id, acquiredAt });
          continue;
        }
      }

      if (Date.now() > deadline) {
        throw new Error(
          `Timed out after ${Math.round(LOCK_WAIT_TIMEOUT_MS / 60_000)} minutes waiting for the migration lock in `
          + `collection "${lockCollectionName}". Another replica is still migrating, or the lock is held by a process `
          + `that is alive but stuck. Inspect it with: db.getCollection("${lockCollectionName}").find({}) — and remove `
          + `the document only once you are sure no migration is running.`,
        );
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
 * Identifies the process holding the lock, so a stale-lock warning names something actionable
 */
function lockOwnerId(): string {
  return `${hostname()}:${process.pid}`;
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
