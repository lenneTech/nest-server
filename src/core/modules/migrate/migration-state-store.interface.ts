/**
 * Where `MigrationRunner` and the `migrate` CLI keep the applied migrations: `MongoStateStore` on MongoDB,
 * `SqlStateStore` on PostgreSQL. Types only.
 */
export interface MigrationSet {
  down?: (done?: (err?: Error) => void) => void;
  lastRun?: string;
  migrations: Array<{ timestamp?: number; title: string }>;
  up: (done?: (err?: Error) => void) => void;
}

export interface MigrationStateStore {
  /** Callback API of the `migrate` package */
  load(fn: (err?: Error, set?: MigrationSet) => void): void;
  loadAsync(): Promise<MigrationSet>;
  /** Callback API of the `migrate` package */
  save(set: MigrationSet, fn: (err?: Error) => void): void;
  saveAsync(set: MigrationSet): Promise<void>;
  /**
   * Run `fn` while holding the store's migration lock, so concurrent runs of several replicas apply each migration
   * once. A store without a lock runs `fn` unsynchronized.
   */
  withLock?<T>(fn: () => Promise<T>): Promise<T>;
}
