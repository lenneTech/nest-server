/**
 * The data store port: the neutral operations every database implements.
 *
 * Import-free on purpose (types only), like every leaf the persistence layer and its DI tokens depend on.
 *
 * Records are plain objects with the id as a string under `id` (never `_id`, never a driver type). Filters
 * and updates use the Mongo-operator subset the codebase already speaks: MongoDB executes them as they
 * are, a SQL store compiles them and refuses what it cannot express — it never drops a condition.
 */

/**
 * Neutral filter: implicit equality, dot paths into embedded objects, and the operators
 * `$eq $ne $gt $gte $lt $lte $in $nin $exists $regex/$options $and $or $nor $not $all $size $elemMatch`.
 * The id is addressed as `id`.
 */
export type Where<T = Record<string, any>> = { [K in keyof T]?: any } & {
  [path: string]: any;
  $and?: Where<T>[];
  $nor?: Where<T>[];
  $or?: Where<T>[];
};

/**
 * Neutral update: a partial record (equivalent to `$set`), or the operators `$set $unset $inc $push
 * $pull $addToSet $setOnInsert`.
 */
export type DataStoreUpdate<T = Record<string, any>> =
  | Partial<T>
  | {
      $addToSet?: Record<string, unknown>;
      $inc?: Record<string, number>;
      $pull?: Record<string, unknown>;
      $push?: Record<string, unknown>;
      $set?: Partial<T> & Record<string, unknown>;
      $setOnInsert?: Partial<T> & Record<string, unknown>;
      $unset?: Record<string, '' | 1 | true>;
    };

/** A stored record: the model's fields plus its id as a string. */
export type StoredRecord<T = Record<string, any>> = T & { id: string };

export interface FindOptions {
  /** Language-specific string comparison (MongoDB collation; mapped by SQL stores where supported) */
  collation?: Record<string, unknown>;
  limit?: number;
  /**
   * Return this many records chosen at random from the page — after filter, sort, skip and limit, as MongoDB's `$sample`
   * stage follows them in `CrudService.findAndCount()`. A positive integer; a sample larger than the page returns the
   * whole page. The order of the result is random too.
   */
  sample?: number;
  /**
   * Field names to leave out (MongoDB's `-name` projection); everything else the model returns by default is read.
   * Not combinable with `select`, as MongoDB does not combine them either.
   */
  exclude?: readonly string[];
  /**
   * Read tombstones too (a synchronized model's deleted records, `deletedAt` set). Every read of such a model leaves
   * them out unless asked — only the sync module asks. No effect on other models.
   */
  includeTombstones?: boolean;
  /** Field names to return; the id is always returned */
  select?: readonly string[];
  skip?: number;
  /** Field → 1 (ascending) or -1 (descending), applied in declaration order */
  sort?: Record<string, -1 | 1>;
}

/** Options of a read that has no paging (`count`, `distinct`, `findById`) */
export interface ReadOptions {
  /** See `FindOptions.includeTombstones` */
  includeTombstones?: boolean;
}

export interface UpdateOptions {
  /** Match tombstones too (a synchronized model's deleted records) — see `FindOptions.includeTombstones` */
  includeTombstones?: boolean;
  /**
   * `false` leaves the update time (`updatedAt`) as it is — for bookkeeping writes such as a last-used stamp, which
   * must not read as a change of the record (Mongoose's `timestamps: false`). @default true
   */
  timestamps?: boolean;
}

export interface DeleteOptions {
  /**
   * Remove the record for good. A synchronized model's delete otherwise leaves a tombstone (`deletedAt` set, the
   * content cleared, the version incremented), which is how clients learn of it; a hard delete is the tombstone purge's
   * (with `includeTombstones`). No effect on other models, whose delete always removes.
   */
  hardDelete?: boolean;
  /** Match tombstones too — see `FindOptions.includeTombstones` */
  includeTombstones?: boolean;
}

export interface PushOptions {
  /** Insert position (MongoDB `$position`) */
  position?: number;
  /** Keep only this many items after the push: negative = the last n, positive = the first n */
  slice?: number;
  /** Sort the array after the push */
  sort?: Record<string, -1 | 1>;
}

/**
 * What a store can do. Features ask the store, never the driver name; an unavailable capability fails at
 * boot when it is configured and at the call with a named error otherwise.
 */
export interface StoreCapabilities {
  /** `aggregate()` with a MongoDB pipeline */
  aggregatePipeline: boolean;
  /** Change streams / logical replication feed */
  changeFeed: boolean;
  /** GridFS file storage */
  gridfs: boolean;
  /** Mongoose documents and populate — the CrudService pipeline's MongoDB path */
  mongoosePopulate: boolean;
  /** A raw driver filter is passed through untouched */
  rawFilterArm: boolean;
  /** Row-level security enforced by the database */
  rls: boolean;
  /** Full-text search */
  textSearch: boolean;
  /** Multi-statement transactions */
  transactions: boolean;
  /** Format of the model's ids — `uuidv7` only for a synchronized model that declares it */
  idType: 'objectId' | 'uuidv7';
  /**
   * How a synchronized model orders its changes (offline-sync plan §3.4): `seq` — the commit-ordered `syncSeq` (SQL);
   * `clock` — the server clock `syncAt`, read with a window (MongoDB). Absent for a model that is not synchronized.
   */
  changeOrder?: 'clock' | 'seq';
}

export interface DataStore<T = Record<string, any>> {
  readonly capabilities: StoreCapabilities;
  /** The database behind the store (`mongodb`, `postgres`, …) */
  readonly driver: string;
  readonly modelName: string;

  count(where?: Where<T>, options?: ReadOptions): Promise<number>;
  /**
   * Remove the record and return it as it was; `null` when there is none. On a synchronized model: turn it into a
   * tombstone instead, unless `hardDelete` (see `DeleteOptions`).
   */
  deleteById(id: string, options?: DeleteOptions): Promise<null | StoredRecord<T>>;
  /** Remove every record matching `where`; returns how many were removed (tombstoned on a synchronized model). */
  deleteMany(where: Where<T>, options?: DeleteOptions): Promise<number>;
  /**
   * Remove the first record matching `where`, atomically (MongoDB's `findOneAndDelete`), and return it; `null` when
   * nothing matches (tombstoned on a synchronized model).
   */
  deleteOne(where: Where<T>, options?: DeleteOptions): Promise<null | StoredRecord<T>>;
  distinct(field: string, where?: Where<T>, options?: ReadOptions): Promise<unknown[]>;
  find(where?: Where<T>, options?: FindOptions): Promise<StoredRecord<T>[]>;
  findById(
    id: string,
    options?: Pick<FindOptions, 'exclude' | 'includeTombstones' | 'select'>,
  ): Promise<null | StoredRecord<T>>;
  findOne(where: Where<T>, options?: Omit<FindOptions, 'limit' | 'skip'>): Promise<null | StoredRecord<T>>;
  insert(record: Partial<T>): Promise<StoredRecord<T>>;
  /**
   * Tier 2 access: the database library's own API for this model (the Mongoose model on MongoDB), bound
   * to the current unit of work. The reason is mandatory and logged.
   */
  native<N = unknown>(reason: string): N;
  /** Remove every array item matching `condition` from `field`, atomically. */
  pullFromArray(id: string, field: string, condition: unknown): Promise<void>;
  /** Append `items` to the array `field`, atomically. */
  pushToArray(id: string, field: string, items: readonly unknown[], options?: PushOptions): Promise<void>;
  /**
   * Tier 3 access: the raw driver (the MongoDB collection on MongoDB). Bypasses every policy of the
   * store; the reason is mandatory and logged as a security event.
   */
  raw<N = unknown>(reason: string): N;
  /**
   * How many records match `where`, and the total of the numeric `field` over them (a missing value adds 0) — counted
   * by the database, so only the result crosses the wire (MongoDB's `$group`, SQL's `count`/`sum`).
   */
  sum(field: string, where?: Where<T>): Promise<{ count: number; sum: number }>;
  /** Apply `update` to the record and return it as stored afterwards; `null` when there is none. */
  updateById(id: string, update: DataStoreUpdate<T>, options?: UpdateOptions): Promise<null | StoredRecord<T>>;
  /** Apply `update` to every record matching `where`; returns how many records matched. */
  updateMany(where: Where<T>, update: DataStoreUpdate<T>, options?: UpdateOptions): Promise<number>;
  /**
   * Apply `update` to the first record matching `where`, atomically: the record still matches when it is changed, and
   * concurrent callers never change the same record on the strength of one match (MongoDB's `findOneAndUpdate`).
   * Returns the record as stored afterwards; `null` when nothing matches.
   */
  updateOne(where: Where<T>, update: DataStoreUpdate<T>, options?: UpdateOptions): Promise<null | StoredRecord<T>>;
}
