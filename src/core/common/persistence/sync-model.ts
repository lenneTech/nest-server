import type {
  FieldDescriptor,
  IndexDescriptor,
  ModelDescriptor,
  SyncDescriptor,
  SyncIdFormat,
} from './model-descriptor.interface.js';

export type { SyncDescriptor, SyncIdFormat } from './model-descriptor.interface.js';

/**
 * Synchronized models (offline sync, `docs/offline-sync-protocol.md`, plan `.claude/plans/offline-sync/PLAN.md` §3.2).
 *
 * A model declared with `@PersistedModel({ sync })` carries three system fields every store maintains and no caller
 * writes — `version`, `deletedAt` and its position in the change order — and its delete leaves a tombstone instead of
 * removing the record. This leaf holds the declaration, the descriptor it produces and the field names, so the stores,
 * the schema compilers and the Mongoose plugin read one definition. Types and plain functions only: every persistence
 * file may import it without an import cycle.
 */

/**
 * How a push meets a record that changed since the client's base version (protocol §6.4): `reject` answers `conflict`,
 * `lww` applies the change on top (last to ARRIVE at the server wins), `merge` applies the fields the client changed
 * unless one of them is declared `@SyncField('reject')`, `custom` asks the model service's `resolveSyncConflict()`.
 */
export type SyncConflictStrategy = 'custom' | 'lww' | 'merge' | 'reject';

/**
 * Who may do what through the sync routes (protocol §1.3), passed as `serviceOptions.roles` to every `CrudService`
 * call of the module — so `S_CREATOR` and `S_SELF` are decided against the stored record, as everywhere. The roles
 * a project puts on its own routes do not reach `/sync`; an operation without roles here is open to `ADMIN` only.
 */
export interface SyncOperationRoles {
  create?: string[];
  delete?: string[];
  /** Also who may receive hints for the model; `S_CREATOR` / `S_SELF` decide nothing here (a pull has no record) */
  pull?: string[];
  update?: string[];
}

const SYNC_STRATEGIES: readonly SyncConflictStrategy[] = ['custom', 'lww', 'merge', 'reject'];
const SYNC_OPERATIONS: readonly (keyof SyncOperationRoles)[] = ['create', 'delete', 'pull', 'update'];

export interface SyncModelOptions {
  /**
   * Format of the model's ids. `uuidv7` is meant for NEW models: ids are stored as text on SQL and as a BSON UUID
   * (binary subtype 4) on MongoDB, and every reference to the model must hold that format too.
   * @default 'objectId'
   */
  idFormat?: SyncIdFormat;
  /**
   * Operation roles of the sync routes (`SyncOperationRoles`). Read by the sync module only.
   * @default every operation open to ADMIN only (the boot warns until roles are declared)
   */
  roles?: SyncOperationRoles;
  /**
   * The user-id fields a tombstone keeps besides `tenantId` (e.g. `['ownerId']`), so a deletion reaches exactly the
   * users who could see the record. Every other content field is cleared when the record is deleted.
   * @default []
   */
  scope?: string[];
  /**
   * What a push does when the record changed since the client's base version. Read by the sync module only.
   * @default 'reject'
   */
  strategy?: SyncConflictStrategy;
}

/** Incremented by every write; `1` after the insert */
export const SYNC_VERSION_FIELD = 'version';
/** `null` for a live record, the deletion time for a tombstone */
export const SYNC_DELETED_FIELD = 'deletedAt';
/** MongoDB's change position: the server clock of the last write (plan §3.4, C2) */
export const SYNC_CLOCK_FIELD = 'syncAt';
/** The SQL change position: a commit-ordered sequence number (plan §3.4, C1d) */
export const SYNC_SEQUENCE_FIELD = 'syncSeq';
/** The value a multi-row statement writes before its final statement numbers the rows (plan §3.4) */
export const SYNC_SEQUENCE_PENDING = -1;

/** Fields only the store writes on a synchronized model */
export const SYNC_SYSTEM_FIELDS: readonly string[] = Object.freeze([
  SYNC_VERSION_FIELD,
  SYNC_DELETED_FIELD,
  SYNC_CLOCK_FIELD,
  SYNC_SEQUENCE_FIELD,
]);

/**
 * The live-record condition: the same form in every read filter and in every partial unique index, because MongoDB
 * uses a partial index only for a query that implies its filter, and the equality also covers a document without the
 * field (P2-4, measured in phase 2). SQL compiles it to `deleted_at IS NULL`.
 */
export function liveFilter(): { deletedAt: null } {
  return { [SYNC_DELETED_FIELD]: null } as { deletedAt: null };
}

/** The declaration of `@PersistedModel({ sync })`, resolved; `undefined` for a model that is not synchronized */
export function resolveSyncOptions(
  value: boolean | SyncModelOptions | undefined,
  model: string,
): SyncDescriptor | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }
  const options: SyncModelOptions = value === true ? {} : value;
  if (!options || typeof options !== 'object') {
    throw new Error(`@PersistedModel(${model}): sync must be true or an options object`);
  }
  const idFormat = options.idFormat ?? 'objectId';
  if (idFormat !== 'objectId' && idFormat !== 'uuidv7') {
    throw new Error(
      `@PersistedModel(${model}): sync.idFormat must be 'objectId' or 'uuidv7', got ${JSON.stringify(idFormat)}`,
    );
  }
  const scope = options.scope ?? [];
  if (!Array.isArray(scope) || scope.some((field) => typeof field !== 'string' || !field)) {
    throw new Error(`@PersistedModel(${model}): sync.scope must be a list of field names`);
  }
  if (options.strategy !== undefined && !SYNC_STRATEGIES.includes(options.strategy)) {
    throw new Error(
      `@PersistedModel(${model}): sync.strategy must be one of ${SYNC_STRATEGIES.join(', ')}, got ${JSON.stringify(options.strategy)}`,
    );
  }
  if (options.roles !== undefined) {
    const roles = options.roles;
    const invalid =
      !roles ||
      typeof roles !== 'object' ||
      Object.entries(roles).some(
        ([operation, list]) =>
          !SYNC_OPERATIONS.includes(operation as keyof SyncOperationRoles) ||
          !Array.isArray(list) ||
          list.some((role) => typeof role !== 'string' || !role),
      );
    if (invalid) {
      throw new Error(
        `@PersistedModel(${model}): sync.roles maps ${SYNC_OPERATIONS.join(', ')} to lists of role names`,
      );
    }
  }
  return { idFormat, scope: Object.freeze([...scope]) };
}

/**
 * The descriptor of a synchronized model: the system fields added, the id typed by the declared format, and every
 * unique index restricted to live records — so deleting a record and creating one with the same unique value works,
 * on every database (plan §3.6). Database-neutral: the change position (`syncSeq` / `syncAt`) is the store's own
 * column, added by the dialect that keeps it.
 *
 * Refuses what would make the model lose deletions or system fields: a TTL index (records would vanish without a
 * tombstone), a declared field of a system name, a scope field the model does not have.
 */
export function withSyncDescriptor(descriptor: ModelDescriptor, sync: SyncDescriptor): ModelDescriptor {
  const name = descriptor.name;
  for (const field of SYNC_SYSTEM_FIELDS) {
    if (descriptor.fields[field]) {
      throw new Error(`${name}: "${field}" is reserved on a synchronized model — rename the field`);
    }
  }
  for (const field of sync.scope) {
    if (!descriptor.fields[field]) {
      throw new Error(`${name}: sync.scope names "${field}", which the model does not declare`);
    }
  }
  const nestedUnique = descriptor.indexes.find(
    (index) => index.options.unique === true && Object.keys(index.fields).some((path) => path.includes('.')),
  );
  if (nestedUnique) {
    // MongoDB keeps such an index on the embedded schema, out of reach of the live-only rewrite: a tombstone (which
    // keeps no values) would collide on it with the next deletion
    throw new Error(
      `${name}: a unique index inside an embedded object (${JSON.stringify(nestedUnique.fields)}) is not supported on a ` +
        'synchronized model — declare the unique field on the model itself',
    );
  }
  if (
    descriptor.indexes.some((index) => 'expireAfterSeconds' in index.options) ||
    Object.values(descriptor.fields).some((field) => field.expiresAfterSeconds !== undefined)
  ) {
    throw new Error(
      `${name}: a synchronized model cannot expire records (TTL) — an expired record disappears without a tombstone, ` +
        'and every client keeps it',
    );
  }

  const fields: Record<string, FieldDescriptor> = { ...descriptor.fields };
  if (sync.idFormat === 'uuidv7' && fields._id) {
    fields._id = { ...fields._id, kind: 'uuid' };
  }
  fields[SYNC_VERSION_FIELD] = systemField(SYNC_VERSION_FIELD, 'number', 1);
  fields[SYNC_DELETED_FIELD] = systemField(SYNC_DELETED_FIELD, 'date', null);

  return {
    ...descriptor,
    fields,
    indexes: descriptor.indexes.map((index) => liveUniqueIndex(index)),
    sync,
  };
}

/**
 * A unique index restricted to live records. A sparse one keeps its meaning through `$exists` — MongoDB refuses
 * `sparse` together with a `partialFilterExpression`. Every other index is returned unchanged.
 */
export function liveUniqueIndex(index: IndexDescriptor): IndexDescriptor {
  if (index.options.unique !== true) {
    return index;
  }
  const { sparse, ...options } = index.options;
  const existing = (options.partialFilterExpression as Record<string, unknown> | undefined) ?? {};
  const exists =
    sparse === true ? Object.fromEntries(Object.keys(index.fields).map((path) => [path, { $exists: true }])) : {};
  return {
    fields: { ...index.fields },
    options: { ...options, partialFilterExpression: { ...existing, ...exists, ...liveFilter() } },
  };
}

/**
 * The descriptor a SQL store works with: a synchronized model's descriptor plus its commit-ordered change position
 * `syncSeq` (a `bigint` column the database's trigger numbers, plan §3.4) and the pull's index over it, led by the
 * tenant every pull on a tenant-scoped model is filtered by. Any other descriptor is returned as it is.
 */
export function withSequenceField(descriptor: ModelDescriptor): ModelDescriptor {
  if (!descriptor.sync || descriptor.fields[SYNC_SEQUENCE_FIELD]) {
    return descriptor;
  }
  const field = systemField(SYNC_SEQUENCE_FIELD, 'bigint', undefined);
  return {
    ...descriptor,
    fields: { ...descriptor.fields, [SYNC_SEQUENCE_FIELD]: field },
    indexes: [
      ...descriptor.indexes,
      {
        fields: descriptor.tenantScoped ? { tenantId: 1, [SYNC_SEQUENCE_FIELD]: 1 } : { [SYNC_SEQUENCE_FIELD]: 1 },
        options: {},
      },
    ],
  };
}

/** Whether a partial filter is exactly the live-record condition (PostgreSQL then keeps `NULLS NOT DISTINCT`) */
export function isLiveFilter(filter: unknown): boolean {
  if (!filter || typeof filter !== 'object') {
    return false;
  }
  const keys = Object.keys(filter);
  return (
    keys.length === 1 &&
    keys[0] === SYNC_DELETED_FIELD &&
    (filter as Record<string, unknown>)[SYNC_DELETED_FIELD] === null
  );
}

function systemField(name: string, kind: FieldDescriptor['kind'], value: unknown): FieldDescriptor {
  return {
    ...(value === undefined ? {} : { default: value }),
    hasDefault: value !== undefined,
    index: false,
    isArray: false,
    kind,
    lowercase: false,
    name,
    required: false,
    select: true,
    sparse: false,
    trim: false,
    unique: false,
  };
}
