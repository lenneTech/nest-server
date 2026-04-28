/**
 * Mongoose plugin that adds version tracking, soft-delete (tombstones),
 * and cursor-friendly indexes to schemas marked with `syncable: true`.
 *
 * Activation: only fires on schemas with `schema.options.syncable === true`.
 * Schemas without this flag are completely untouched — guarantees zero
 * overhead for existing projects that do not opt into the sync feature.
 *
 * What it does (only on syncable schemas):
 * 1. Adds `version: Number` (default 1) and `deletedAt: Date | null` fields
 *    if they do not already exist. Field names are configurable via
 *    `pluginOptions.fields`.
 * 2. Adds a compound cursor index `{ updatedAt: 1, _id: 1 }` for
 *    deterministic delta-pagination.
 * 3. Adds an optional tombstone index `{ deletedAt: 1, updatedAt: 1 }`
 *    (can be disabled per schema via `schema.options.syncTombstoneIndex: false`).
 * 4. Auto-increments `version` on every write path:
 *    - pre('save')
 *    - pre('findOneAndUpdate' | 'updateOne' | 'updateMany' | 'replaceOne' | 'findOneAndReplace')
 *    - pre('insertMany')
 *    - pre('bulkWrite')
 *    A marker symbol on the update prevents double-incrementing when callers
 *    (e.g. CrudService.update with expectedVersion) already set `$inc.version`.
 * 5. Filters out tombstones (deletedAt != null) on every read path:
 *    - pre('find' | 'findOne' | 'findOneAndUpdate' | 'countDocuments' | 'distinct')
 *    - pre('aggregate')
 *    Bypass: `query.setOptions({ _includeDeleted: true })` — only used by
 *    internal sync code paths, never exposed via HTTP.
 *
 * Plugin order: must run AFTER mongooseTenantPlugin so tombstone filter
 * combines cleanly with tenant filter via `$and`.
 *
 * Configuration (via second argument to schema.plugin or connection.plugin):
 *   fields?: { version?: string; deletedAt?: string }  // default: 'version', 'deletedAt'
 */

const SYNC_VERSION_HANDLED = Symbol('syncVersionHandled');

export interface MongooseSyncPluginOptions {
  fields?: {
    version?: string;
    deletedAt?: string;
  };
}

export function mongooseSyncPlugin(schema: any, options: MongooseSyncPluginOptions = {}) {
  // Gate: only run on schemas explicitly opted in via schema.options.syncable === true.
  if (schema.options?.syncable !== true) {
    return;
  }

  const versionField = options?.fields?.version || 'version';
  const deletedAtField = options?.fields?.deletedAt || 'deletedAt';

  // 1. Ensure version + deletedAt fields exist on the schema.
  if (!schema.path(versionField)) {
    schema.add({ [versionField]: { type: Number, default: 1 } });
  }
  if (!schema.path(deletedAtField)) {
    schema.add({ [deletedAtField]: { type: Date, default: null, index: true } });
  }

  // 2. Cursor index (compound) — covers (updatedAt, _id)-based pagination.
  schema.index({ updatedAt: 1, _id: 1 });

  // 3. Tombstone index (compound) — opt-out per schema via syncTombstoneIndex: false.
  if (schema.options?.syncTombstoneIndex !== false) {
    schema.index({ [deletedAtField]: 1, updatedAt: 1 });
  }

  // 4a. Version increment on save.
  schema.pre('save', function () {
    if (this.isNew) {
      // Initial version always 1 (unless caller set it explicitly).
      if (!this[versionField] || typeof this[versionField] !== 'number') {
        this[versionField] = 1;
      }
      return;
    }
    if (this.isModified()) {
      this[versionField] = (this[versionField] || 0) + 1;
    }
  });

  // 4b. Version increment on update queries.
  const versionUpdateHook = function () {
    const update = this.getUpdate();
    if (!update) return;

    // Already handled by caller (e.g. expectedVersion-CAS in CrudService).
    if (update[SYNC_VERSION_HANDLED]) {
      return;
    }

    // Determine if this is a replace operation (entire doc).
    if (this.op === 'replaceOne' || this.op === 'findOneAndReplace') {
      // For replacements: ensure version is at least 1 if missing.
      if (typeof update[versionField] !== 'number') {
        update[versionField] = 1;
      }
      return;
    }

    // For updates: add $inc.version (or merge if $inc already exists).
    if (!update.$inc) {
      update.$inc = {};
    }
    if (typeof update.$inc[versionField] !== 'number') {
      update.$inc[versionField] = 1;
    }
    update[SYNC_VERSION_HANDLED] = true;
  };

  schema.pre('findOneAndUpdate', versionUpdateHook);
  schema.pre('updateOne', versionUpdateHook);
  schema.pre('updateMany', versionUpdateHook);
  schema.pre('replaceOne', versionUpdateHook);
  schema.pre('findOneAndReplace', versionUpdateHook);

  // 4c. Version on insertMany.
  schema.pre('insertMany', function (docs: any) {
    if (!Array.isArray(docs)) return;
    for (const doc of docs) {
      if (typeof doc[versionField] !== 'number') {
        doc[versionField] = 1;
      }
    }
  });

  // 4d. Version on bulkWrite.
  schema.pre('bulkWrite', function (ops: any) {
    if (!Array.isArray(ops)) return;
    for (const op of ops) {
      if ('insertOne' in op) {
        const doc = op.insertOne.document;
        if (typeof doc[versionField] !== 'number') {
          doc[versionField] = 1;
        }
      } else if ('updateOne' in op || 'updateMany' in op) {
        const update = 'updateOne' in op ? op.updateOne.update : op.updateMany.update;
        if (!update || update[SYNC_VERSION_HANDLED]) continue;
        if (!update.$inc) update.$inc = {};
        if (typeof update.$inc[versionField] !== 'number') {
          update.$inc[versionField] = 1;
        }
        update[SYNC_VERSION_HANDLED] = true;
      } else if ('replaceOne' in op) {
        const replacement = op.replaceOne.replacement;
        if (typeof replacement[versionField] !== 'number') {
          replacement[versionField] = 1;
        }
      }
    }
  });

  // 5a. Tombstone filter on read queries.
  const tombstoneReadHook = function () {
    const opts = this.getOptions ? this.getOptions() : {};
    if (opts?._includeDeleted === true) return;
    // Use $and to combine cleanly with existing filters (e.g. tenantId from tenant plugin).
    const existing = this.getFilter ? this.getFilter() : null;
    if (existing && existing[deletedAtField] !== undefined) {
      // Caller already specified a deletedAt filter — don't override.
      return;
    }
    this.where({ [deletedAtField]: null });
  };

  schema.pre('find', tombstoneReadHook);
  schema.pre('findOne', tombstoneReadHook);
  schema.pre('findOneAndUpdate', tombstoneReadHook);
  schema.pre('countDocuments', tombstoneReadHook);
  schema.pre('distinct', tombstoneReadHook);

  // 5b. Tombstone filter on aggregate.
  schema.pre('aggregate', function () {
    const opts = this.options || {};
    if (opts?._includeDeleted === true) return;
    const pipeline = this.pipeline();
    // Prepend $match if not already present at position 0.
    pipeline.unshift({ $match: { [deletedAtField]: null } });
  });
}

/**
 * Internal symbol used by the plugin to mark updates whose version was
 * already handled. Not exported.
 */
mongooseSyncPlugin.VERSION_HANDLED_SYMBOL = SYNC_VERSION_HANDLED;
