import { ConfigService } from '../services/config.service';
import { RequestContext } from '../services/request-context.service';

/**
 * Mongoose plugin that provides automatic tenant-based data isolation.
 * Only activates on schemas that have a `tenantId` path defined.
 *
 * Follows the same pattern as mongooseRoleGuardPlugin and mongooseAuditFieldsPlugin:
 * - Plain function, registered globally in connectionFactory
 * - Reads RequestContext (AsyncLocalStorage) and ConfigService.configFastButReadOnly
 * - Activates conditionally based on schema structure
 *
 * **Behavior:**
 * - Queries are automatically filtered by the current user's tenantId
 * - New documents get tenantId set automatically from context
 * - Aggregates get a $match stage prepended
 *
 * **No filter applied when:**
 * - No RequestContext (system operations, cron jobs, migrations)
 * - `bypassTenantGuard` is active (via `RequestContext.runWithBypassTenantGuard()`)
 * - Schema's model name is in `excludeSchemas` config
 * - No user on request (public endpoints)
 *
 * **User without tenantId:**
 * - Filters by `{ tenantId: null }` — sees only data without tenant assignment
 * - Falsy values (undefined, null, empty string '') are all treated as "no tenant"
 */
export function mongooseTenantPlugin(schema) {
  // Only activate on schemas with a tenantId path
  if (!schema.path('tenantId')) {
    return;
  }

  // Performance index
  schema.index({ tenantId: 1 });

  // === Query filter hooks (explicit names, no regex → no double-filtering) ===
  const queryHooks = [
    'find',
    'findOne',
    'findOneAndUpdate',
    'findOneAndDelete',
    'findOneAndReplace',
    'countDocuments',
    'distinct',
    'updateOne',
    'updateMany',
    'deleteOne',
    'deleteMany',
    'replaceOne',
  ];

  for (const hookName of queryHooks) {
    schema.pre(hookName, function () {
      // Query hooks: `this` is a Mongoose Query — modelName is on `this.model`
      const modelName = this.model?.modelName;
      const tenantId = resolveTenantId(modelName);
      if (tenantId !== undefined) {
        this.where({ tenantId });
      }
    });
  }

  // === Save: set tenantId automatically on new documents ===
  // Intentional asymmetry: writes only set tenantId when truthy (not null).
  // A user without tenantId creates "unassigned" documents, which the null-filter
  // in query hooks will still make visible to them on reads.
  schema.pre('save', function () {
    if (this.isNew && !this['tenantId']) {
      // Document hooks: `this` is the document instance — modelName is on the constructor (the Model class)
      const modelName = (this.constructor as any).modelName;
      const tenantId = resolveTenantId(modelName);
      if (tenantId) {
        this['tenantId'] = tenantId;
      }
    }
  });

  // === insertMany (Mongoose 9: first arg is docs array, no next callback) ===
  schema.pre('insertMany', function (docs: any[]) {
    // Model-level hooks: `this` is the Model class itself — modelName is a direct property
    const modelName = this.modelName;
    const tenantId = resolveTenantId(modelName);
    if (tenantId && Array.isArray(docs)) {
      for (const doc of docs) {
        if (!doc.tenantId) {
          doc.tenantId = tenantId;
        }
      }
    }
  });

  // === bulkWrite: filter queries and auto-set tenantId on inserts ===
  schema.pre('bulkWrite', function (ops: any[]) {
    // Model-level hooks: `this` is the Model class itself — modelName is a direct property
    const modelName = this.modelName;
    const tenantId = resolveTenantId(modelName);
    if (tenantId === undefined) return;

    for (const op of ops) {
      if ('insertOne' in op) {
        // Auto-set tenantId on insert (only if truthy, consistent with save hook)
        if (tenantId && !op.insertOne.document.tenantId) {
          op.insertOne.document.tenantId = tenantId;
        }
      } else if ('updateOne' in op) {
        op.updateOne.filter = { ...op.updateOne.filter, tenantId };
      } else if ('updateMany' in op) {
        op.updateMany.filter = { ...op.updateMany.filter, tenantId };
      } else if ('replaceOne' in op) {
        op.replaceOne.filter = { ...op.replaceOne.filter, tenantId };
      } else if ('deleteOne' in op) {
        op.deleteOne.filter = { ...op.deleteOne.filter, tenantId };
      } else if ('deleteMany' in op) {
        op.deleteMany.filter = { ...op.deleteMany.filter, tenantId };
      }
    }
  });

  // === Aggregate: prepend $match stage ===
  schema.pre('aggregate', function () {
    // Aggregate hooks: `this` is the Aggregation pipeline — the model is on the internal `_model` property
    const modelName = (this as any)._model?.modelName;
    const tenantId = resolveTenantId(modelName);
    if (tenantId !== undefined) {
      this.pipeline().unshift({ $match: { tenantId } });
    }
  });
}

/**
 * Resolve tenant ID from RequestContext.
 *
 * @returns
 * - `undefined` → no filter should be applied
 * - `string` → filter by this tenant ID
 * - `null` → filter by `{ tenantId: null }` (user without tenant sees only unassigned data)
 */
function resolveTenantId(modelName?: string): string | null | undefined {
  // Defense-in-depth: check config even if plugin is registered
  const mtConfig = ConfigService.configFastButReadOnly?.multiTenancy;
  if (!mtConfig || mtConfig.enabled === false) return undefined;

  const context = RequestContext.get();

  // No RequestContext (system operation, cron, migration) → no filter
  if (!context) return undefined;

  // Explicit bypass
  if (context.bypassTenantGuard) return undefined;

  // Check excluded schemas (model names, e.g. ['User', 'Session'])
  if (modelName && mtConfig.excludeSchemas?.includes(modelName)) return undefined;

  const tenantId = context.tenantId;

  // User has tenantId → filter by it (empty string is treated as falsy = no tenant)
  if (tenantId) return tenantId;

  // User is logged in but has no tenantId (undefined, null, or '') → null filter (sees only data without tenant)
  if (context.currentUser) return null;

  // No user (public endpoint) → no filter
  return undefined;
}
