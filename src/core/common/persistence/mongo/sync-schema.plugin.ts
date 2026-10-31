import { BadRequestException, Logger } from '@nestjs/common';

import { generateUuidV7 } from '../id-format.js';
import type { SyncDescriptor } from '../model-descriptor.interface.js';
import {
  liveFilter,
  liveUniqueIndex,
  SYNC_CLOCK_FIELD,
  SYNC_DELETED_FIELD,
  SYNC_SYSTEM_FIELDS,
  SYNC_VERSION_FIELD,
} from '../sync-model.js';

/**
 * The MongoDB side of a synchronized model (offline-sync plan §3.3, E1–E4): applied by
 * `CorePersistenceModule.forFeature()` to the schema of a model declared with `@PersistedModel({ sync })`, and to no
 * other schema.
 *
 * Every write path of Mongoose runs through these hooks, so `CrudService` (which uses Mongoose documents on MongoDB),
 * `MongooseDataStore` and a project's direct model calls keep the same rules:
 *
 * - **version** — `1` on insert, `$inc` on every update, a save of a loaded document conditional on the version it
 *   was loaded with; a caller never writes it
 * - **change position** — `syncAt` from the SERVER clock: `$currentDate` on every update (one operation), and on an
 *   insert the server clock as read through `hello.localTime` (`mongoServerNow()`), because `save()` has no
 *   server-side value and keeping `save()` keeps every other plugin's save hooks and the validation
 * - **tombstones** — `deletedAt: null` is added to every read and to the match of every update and delete, unless
 *   the query carries `includeTombstones()`; only the store's tombstone write may set `deletedAt`
 * - **unique indexes** apply to live records only
 *
 * A replacement (`replaceOne`, `findOneAndReplace`) and a pipeline update are refused: neither can carry the version
 * increment and the server-clock stamp. A hard delete through the model (`deleteOne`, `deleteMany`) stays possible
 * — tier 2 of the native access; the framework's delete paths write tombstones (`MongooseDataStore`, `CrudService`).
 */

/** Marks a schema the plugin was applied to (once per schema, however often it is registered) */
export const SYNC_SCHEMA = Symbol('lt:syncSchema');
/** On a query: read and match tombstones too */
const INCLUDE_TOMBSTONES = Symbol('lt:includeTombstones');
/** On a query: the store's tombstone write, the one update allowed to set `deletedAt` */
const TOMBSTONE_WRITE = Symbol('lt:tombstoneWrite');

const logger = new Logger('SyncSchema');
/** Where Mongoose keeps a field-level index declaration on a path */
const PATH_INDEX = '_index';

/** Let a Mongoose query of a synchronized model read (or match) tombstones too. Returns the query. */
export function includeTombstones<Q extends object>(query: Q): Q {
  (query as any)[INCLUDE_TOMBSTONES] = true;
  return query;
}

/** Mark a Mongoose update query as the store's tombstone write. Returns the query. */
export function tombstoneWrite<Q extends object>(query: Q): Q {
  (query as any)[TOMBSTONE_WRITE] = true;
  return query;
}

/** Whether a schema (or a model's schema) belongs to a synchronized model */
export function isSyncSchema(schema: unknown): boolean {
  return !!schema && typeof schema === 'object' && (schema as any)[SYNC_SCHEMA] !== undefined;
}

/** The sync declaration a schema was prepared with */
export function syncOfSchema(schema: unknown): SyncDescriptor | undefined {
  return isSyncSchema(schema) ? (schema as any)[SYNC_SCHEMA] : undefined;
}

/**
 * Prepare a Mongoose schema for a synchronized model: system paths, the id type, live-only unique indexes, the
 * change-order index and the hooks. Idempotent per schema.
 */
export function applySyncSchema(schema: any, sync: SyncDescriptor): void {
  if (schema[SYNC_SCHEMA]) {
    return;
  }
  schema[SYNC_SCHEMA] = sync;

  if (sync.idFormat === 'uuidv7') {
    schema.add({ _id: { default: generateUuidV7, type: 'UUID' } });
    allowUuidRanges(schema.path('_id'));
  }
  schema.add({
    [SYNC_CLOCK_FIELD]: { type: Date },
    [SYNC_DELETED_FIELD]: { default: null, type: Date },
    [SYNC_VERSION_FIELD]: { default: 1, type: Number },
  });

  // Every unique index — field-level ones included — applies to live records only (plan §3.6)
  const indexes: Array<[Record<string, unknown>, Record<string, unknown>?]> = schema.indexes();
  schema.eachPath((_path: string, schemaType: any) => {
    // A field-level index lives on the path's schema type; cleared here, it is declared again below, rewritten
    if (schemaType[PATH_INDEX]) {
      schemaType[PATH_INDEX] = null;
    }
  });
  schema.clearIndexes();
  for (const [fields, options = {}] of indexes) {
    const index = liveUniqueIndex({ fields: fields as Record<string, number | string>, options });
    schema.index(index.fields, index.options);
  }
  // The pull's keyset, led by the tenant every pull on a tenant-scoped model is filtered by (plan §3.4)
  schema.index(
    schema.path('tenantId') ? { tenantId: 1, [SYNC_CLOCK_FIELD]: 1, _id: 1 } : { [SYNC_CLOCK_FIELD]: 1, _id: 1 },
  );

  registerHooks(schema);
}

/**
 * Let range operators (`$gt`, `$gte`, `$lt`, `$lte`) be cast on a UUID path, as Mongoose casts them on an ObjectId
 * path. Mongoose's UUID type refuses them ("Can't use $gt with UUID."), so the keyset of a pull — `(syncAt, _id)`,
 * continued strictly after the last record — could not be expressed for a uuidv7 model, nor a neutral
 * `find({ id: { $gt } })`. MongoDB orders BSON UUIDs (binary subtype 4) by their bytes, the order `sort({ _id: 1 })`
 * uses. Defined on this path only: the handlers object on the prototype is shared by every UUID path of the process.
 */
function allowUuidRanges(path: any): void {
  if (!path?.$conditionalHandlers) {
    return;
  }
  const single = function (this: any, value: unknown) {
    return this.cast(value);
  };
  Object.defineProperty(path, '$conditionalHandlers', {
    enumerable: false,
    value: { ...path.$conditionalHandlers, $gt: single, $gte: single, $lt: single, $lte: single },
  });
}

/** A MongoDB collection that holds data from before its model was synchronized — the migration it needs */
export class SyncMigrationRequiredError extends Error {
  override readonly name = 'SyncMigrationRequiredError';

  constructor(
    readonly model: string,
    readonly statements: string[],
  ) {
    super(
      `${model} is synchronized, but its collection holds data from before: run these statements in a migration, ` +
        `then start again —\n${statements.map((statement) => `  ${statement}`).join('\n')}\n` +
        'Until the old unique indexes are dropped, a second delete fails on them (a tombstone keeps no values), and a ' +
        'document without a change position never reaches a client.',
    );
  }
}

/**
 * Refuse to run a synchronized model on a collection that is not ready for it — the MongoDB counterpart of the SQL
 * migrator's refusal (offline-sync plan §3.6). Two things block: a unique index that is not restricted to live
 * records (Mongoose cannot replace it under the same name, and a tombstone's missing value collides on it), and a
 * document without `syncAt` (written before the model was synchronized: no version, no change position). Reads the
 * index list and one document id through the driver — an administrative read, no data leaves the process.
 */
export async function assertSyncCollectionReady(model: any): Promise<void> {
  if (!isSyncSchema(model?.schema) || !model.collection) {
    return;
  }
  let indexes: Array<{ key: Record<string, unknown>; name: string; partialFilterExpression?: any; unique?: boolean }>;
  try {
    indexes = await model.collection.indexes();
  } catch (error) {
    // A collection that does not exist yet holds nothing from before
    if ((error as { code?: unknown })?.code === 26) {
      return;
    }
    throw error;
  }
  const name = model.collection.collectionName ?? model.collection.name;
  const statements: string[] = [];
  for (const index of indexes) {
    if (index.unique && index.name !== '_id_' && index.partialFilterExpression?.[SYNC_DELETED_FIELD] !== null) {
      statements.push(`db.getCollection(${JSON.stringify(name)}).dropIndex(${JSON.stringify(index.name)})`);
    }
  }
  const unstamped = await model.collection.findOne(
    { [SYNC_CLOCK_FIELD]: { $exists: false } },
    { projection: { _id: 1 } },
  );
  if (unstamped) {
    statements.push(
      `db.getCollection(${JSON.stringify(name)}).updateMany({ ${SYNC_CLOCK_FIELD}: { $exists: false } }, ` +
        `[{ $set: { ${SYNC_VERSION_FIELD}: { $ifNull: ['$${SYNC_VERSION_FIELD}', 1] }, ${SYNC_DELETED_FIELD}: { $ifNull: ['$${SYNC_DELETED_FIELD}', null] }, ${SYNC_CLOCK_FIELD}: '$$NOW' } }])`,
    );
  }
  if (statements.length) {
    throw new SyncMigrationRequiredError(model.modelName, statements);
  }
}

/**
 * The server's clock (plan §3.4: app clocks differ between instances, so the insert's stamp must follow the
 * database's). Read through `hello.localTime` and carried forward with this process's MONOTONIC clock — never its wall
 * clock, so neither a skewed nor a stepped application clock moves the stamp. Read again every `CLOCK_REFRESH_MS`,
 * which bounds the drift between the two clocks; the error is half a round trip plus that drift.
 */
export async function mongoServerNow(connection: any): Promise<Date> {
  let reading = clockReadings.get(connection);
  if (!reading) {
    reading = await readServerClock(connection);
    clockReadings.set(connection, reading);
  } else if (performance.now() - reading.mono > CLOCK_REFRESH_MS && !reading.refreshing) {
    const current = reading;
    current.refreshing = readServerClock(connection)
      .then((fresh) => clockReadings.set(connection, fresh))
      .then(() => undefined)
      .finally(() => {
        current.refreshing = undefined;
      });
  }
  return new Date(reading.server + (performance.now() - reading.mono));
}

/**
 * The margin of the window W over the time a write needs from its stamp until it is visible (plan §3.4, §10; decided in
 * DEV-3901). An insert is stamped before it is sent, so a write waiting for a pooled connection or a slow network ages
 * by that wait; a window too small loses such a change for good, a larger one only repeats records a client already has.
 */
export const SYNC_WINDOW_MARGIN_MS = 30_000;

/** MongoDB's default `transactionLifetimeLimitSeconds`, assumed when the server does not tell */
const DEFAULT_TRANSACTION_LIFETIME_SECONDS = 60;

const changeWindows = new WeakMap<object, Promise<number>>();

/**
 * The window W of a pull on this connection: on a replica set or a sharded cluster a write in a project's transaction
 * is stamped when it executes and becomes visible at commit, up to `transactionLifetimeLimitSeconds` later, so W covers
 * that limit plus the margin; a standalone has no transactions and needs the margin only. Read once per connection. A
 * server that cannot be asked gets the larger window — too large repeats records, too small loses changes.
 */
export function mongoChangeWindowMs(connection: any): Promise<number> {
  let window = changeWindows.get(connection);
  if (!window) {
    window = readChangeWindow(connection);
    changeWindows.set(connection, window);
  }
  return window;
}

async function readChangeWindow(connection: any): Promise<number> {
  const transactional = DEFAULT_TRANSACTION_LIFETIME_SECONDS * 1000 + SYNC_WINDOW_MARGIN_MS;
  try {
    const admin = connection.db.admin();
    const hello = await admin.command({ hello: 1 });
    if (!hello?.setName && hello?.msg !== 'isdbgrid') {
      return SYNC_WINDOW_MARGIN_MS;
    }
    try {
      const parameter = await admin.command({ getParameter: 1, transactionLifetimeLimitSeconds: 1 });
      const lifetime = Number(parameter?.transactionLifetimeLimitSeconds);
      return Number.isFinite(lifetime) && lifetime > 0 ? lifetime * 1000 + SYNC_WINDOW_MARGIN_MS : transactional;
    } catch {
      // The application user may not read server parameters: assume the default lifetime
      return transactional;
    }
  } catch {
    // Not asked successfully: not cached, the next pull asks again
    changeWindows.delete(connection);
    return transactional;
  }
}

const CLOCK_REFRESH_MS = 30_000;
const clockReadings = new WeakMap<object, { mono: number; refreshing?: Promise<void>; server: number }>();
let clockWarned = false;

async function readServerClock(connection: any): Promise<{ mono: number; server: number }> {
  try {
    const before = performance.now();
    const hello = await connection.db.admin().command({ hello: 1 });
    const after = performance.now();
    const server = hello?.localTime instanceof Date ? hello.localTime.getTime() : Number.NaN;
    if (Number.isFinite(server)) {
      return { mono: (before + after) / 2, server };
    }
    warnClock('MongoDB did not report its clock (hello.localTime)');
  } catch (error) {
    warnClock(`Cannot read the MongoDB server clock (${(error as Error)?.message ?? error})`);
  }
  return { mono: performance.now(), server: Date.now() };
}

function warnClock(cause: string): void {
  if (!clockWarned) {
    clockWarned = true;
    logger.warn(`${cause}; inserts of synchronized models use this process's clock until it can be read`);
  }
}

// -- hooks ----------------------------------------------------------------------------------------------------

function registerHooks(schema: any): void {
  schema.pre('save', async function (this: any) {
    const connection = this.constructor?.db;
    if (this.isNew) {
      this.set(SYNC_VERSION_FIELD, 1);
      this.set(SYNC_DELETED_FIELD, null);
      this.set(SYNC_CLOCK_FIELD, await mongoServerNow(connection));
      return;
    }
    if (!this.modifiedPaths().length) {
      return;
    }
    for (const field of SYNC_SYSTEM_FIELDS) {
      if (this.isModified(field)) {
        throw new BadRequestException(`${field} of a synchronized record is written by the store, not by the caller`);
      }
    }
    // A loaded document is saved only if nobody changed it since: the version it was loaded with is the condition
    const loaded = this.get(SYNC_VERSION_FIELD);
    this.$where = { ...this.$where, [SYNC_VERSION_FIELD]: loaded ?? null, ...liveFilter() };
    this.set(SYNC_VERSION_FIELD, (typeof loaded === 'number' ? loaded : 0) + 1);
    this.set(SYNC_CLOCK_FIELD, await mongoServerNow(connection));
  });

  schema.pre('insertMany', async function (this: any, docs: any[]) {
    if (!Array.isArray(docs) || !docs.length) {
      return;
    }
    const now = await mongoServerNow(this.db);
    for (const doc of docs) {
      setField(doc, SYNC_VERSION_FIELD, 1);
      setField(doc, SYNC_DELETED_FIELD, null);
      setField(doc, SYNC_CLOCK_FIELD, now);
    }
  });

  for (const hook of ['findOneAndUpdate', 'updateOne', 'updateMany']) {
    schema.pre(hook, function (this: any) {
      matchLive(this);
      this.setUpdate(syncUpdate(this.getUpdate(), this[TOMBSTONE_WRITE] === true));
    });
  }

  for (const hook of ['find', 'findOne', 'countDocuments', 'distinct', 'findOneAndDelete', 'deleteOne', 'deleteMany']) {
    schema.pre(hook, function (this: any) {
      matchLive(this);
    });
  }

  for (const hook of ['replaceOne', 'findOneAndReplace']) {
    schema.pre(hook, function () {
      throw new BadRequestException(
        'A synchronized record cannot be replaced: a replacement carries neither the version increment nor the change ' +
          'position — update it instead',
      );
    });
  }

  schema.pre('bulkWrite', async function (this: any, ops: any[]) {
    if (!Array.isArray(ops) || !ops.length) {
      return;
    }
    let now: Date | undefined;
    for (const op of ops) {
      if (op.insertOne) {
        now ??= await mongoServerNow(this.db);
        setField(op.insertOne.document, SYNC_VERSION_FIELD, 1);
        setField(op.insertOne.document, SYNC_DELETED_FIELD, null);
        setField(op.insertOne.document, SYNC_CLOCK_FIELD, now);
      } else if (op.updateOne || op.updateMany) {
        const entry = op.updateOne ?? op.updateMany;
        entry.filter = { $and: [entry.filter ?? {}, liveFilter()] };
        entry.update = syncUpdate(entry.update, false);
      } else if (op.deleteOne || op.deleteMany) {
        const entry = op.deleteOne ?? op.deleteMany;
        entry.filter = { $and: [entry.filter ?? {}, liveFilter()] };
      } else if (op.replaceOne) {
        throw new BadRequestException('A synchronized record cannot be replaced — update it instead');
      }
    }
  });

  schema.pre('aggregate', function (this: any) {
    const pipeline = this.pipeline();
    if (!this[INCLUDE_TOMBSTONES]) {
      matchLiveInPipeline(pipeline);
    }
    // A join into a synchronized collection sees live records only, whatever the source asked for
    matchLiveInJoins(pipeline, this._model);
  });
}

/**
 * Restrict an aggregation over a synchronized collection to its live records. A stage MongoDB requires first
 * (`$geoNear`, `$search`, `$searchMeta`, `$vectorSearch`) keeps its place: `$geoNear` takes the live filter into its
 * own `query`, the search stages get the `$match` right after them.
 */
export function matchLiveInPipeline(pipeline: any[]): void {
  const first = pipeline[0];
  if (first?.$geoNear) {
    first.$geoNear.query = first.$geoNear.query ? { $and: [first.$geoNear.query, liveFilter()] } : liveFilter();
  } else if (first && (first.$search || first.$searchMeta || first.$vectorSearch)) {
    pipeline.splice(1, 0, { $match: liveFilter() });
  } else {
    pipeline.unshift({ $match: liveFilter() });
  }
}

function matchLive(query: any): void {
  if (!query[INCLUDE_TOMBSTONES]) {
    // `$and`, so a caller's own `deletedAt` condition is kept rather than overwritten
    query.and([liveFilter()]);
  }
}

/**
 * A caller's update as a synchronized model writes it: the system fields removed (the store's tombstone write keeps
 * `deletedAt`), the version incremented and the change position stamped by the server
 */
function syncUpdate(update: any, tombstone: boolean): any {
  if (Array.isArray(update)) {
    throw new BadRequestException(
      'A pipeline update cannot be applied to a synchronized record: it would not carry the version increment',
    );
  }
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(update ?? {})) {
    if (!key.startsWith('$')) {
      if (!isSystemPath(key, tombstone)) {
        result.$set = { ...result.$set, [key]: value };
      }
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // `$rename` names a path on both sides: neither may be a system field
      const kept = Object.fromEntries(
        Object.entries(value).filter(
          ([path, target]) =>
            !isSystemPath(path, tombstone) &&
            !(key === '$rename' && typeof target === 'string' && isSystemPath(target, false)),
        ),
      );
      if (Object.keys(kept).length) {
        result[key] = { ...result[key], ...kept };
      }
    } else {
      result[key] = value;
    }
  }
  result.$inc = { ...result.$inc, [SYNC_VERSION_FIELD]: 1 };
  result.$currentDate = { ...result.$currentDate, [SYNC_CLOCK_FIELD]: true };
  return result;
}

function isSystemPath(path: string, tombstone: boolean): boolean {
  const head = path.split('.', 1)[0];
  if (tombstone && head === SYNC_DELETED_FIELD) {
    return false;
  }
  return SYNC_SYSTEM_FIELDS.includes(head);
}

function setField(doc: any, field: string, value: unknown): void {
  if (doc && typeof doc.set === 'function' && typeof doc.$isNew === 'boolean') {
    doc.set(field, value);
  } else if (doc && typeof doc === 'object') {
    doc[field] = value;
  }
}

/** A join into a synchronized model's collection sees its live records only, like a direct query */
function matchLiveInJoins(pipeline: any[], model: any): void {
  if (!Array.isArray(pipeline)) {
    return;
  }
  for (const stage of pipeline) {
    if (!stage || typeof stage !== 'object') {
      continue;
    }
    if (stage.$lookup) {
      if (isSyncCollection(stage.$lookup.from, model)) {
        stage.$lookup.pipeline = [{ $match: liveFilter() }, ...(stage.$lookup.pipeline ?? [])];
      }
      matchLiveInJoins(stage.$lookup.pipeline, model);
    }
    if (stage.$unionWith) {
      if (typeof stage.$unionWith === 'string') {
        if (isSyncCollection(stage.$unionWith, model)) {
          stage.$unionWith = { coll: stage.$unionWith, pipeline: [{ $match: liveFilter() }] };
        }
      } else {
        if (isSyncCollection(stage.$unionWith.coll, model)) {
          stage.$unionWith.pipeline = [{ $match: liveFilter() }, ...(stage.$unionWith.pipeline ?? [])];
        }
        matchLiveInJoins(stage.$unionWith.pipeline, model);
      }
    }
    if (stage.$graphLookup && isSyncCollection(stage.$graphLookup.from, model)) {
      stage.$graphLookup.restrictSearchWithMatch = { ...stage.$graphLookup.restrictSearchWithMatch, ...liveFilter() };
    }
    if (stage.$facet && typeof stage.$facet === 'object') {
      for (const branch of Object.values(stage.$facet)) {
        matchLiveInJoins(branch as any[], model);
      }
    }
  }
}

function isSyncCollection(collection: unknown, sourceModel: any): boolean {
  if (typeof collection !== 'string' || !collection) {
    return false;
  }
  const models = sourceModel?.db?.models ?? {};
  return Object.values(models).some(
    (candidate: any) => candidate?.collection?.name === collection && isSyncSchema(candidate.schema),
  );
}
