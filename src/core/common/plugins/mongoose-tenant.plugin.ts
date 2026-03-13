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
 * **Filter modes:**
 * - X-Tenant-Id header set → `{ tenantId: headerValue }` (single tenant)
 * - No header + authenticated user → `{ tenantId: { $in: userTenantIds } }` (all user's tenants)
 * - No header + no user → no filter (public/system routes)
 *
 * **No filter applied when:**
 * - No RequestContext (system operations, cron jobs, migrations)
 * - `bypassTenantGuard` is active (via `RequestContext.runWithBypassTenantGuard()`)
 * - Schema's model name is in `excludeSchemas` config
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
      const filter = resolveTenantFilter(modelName);
      if (filter !== undefined) {
        this.where(filter);
      }
    });
  }

  // === Save: set tenantId automatically on new documents ===
  // Intentional asymmetry: writes only set tenantId when truthy (not null).
  // Only uses single tenantId from header — tenantIds array is for reads only.
  schema.pre('save', function () {
    if (this.isNew && !this['tenantId']) {
      // Document hooks: `this` is the document instance — modelName is on the constructor (the Model class)
      const modelName = (this.constructor as any).modelName;
      const tenantId = resolveSingleTenantId(modelName);
      if (tenantId) {
        this['tenantId'] = tenantId;
      }
    }
  });

  // === insertMany (Mongoose 9: first arg is docs array, no next callback) ===
  schema.pre('insertMany', function (docs: any[]) {
    // Model-level hooks: `this` is the Model class itself — modelName is a direct property
    const modelName = this.modelName;
    const tenantId = resolveSingleTenantId(modelName);
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
    const filter = resolveTenantFilter(modelName);
    if (filter === undefined) return;

    const tenantId = resolveSingleTenantId(modelName);

    for (const op of ops) {
      if ('insertOne' in op) {
        // Auto-set tenantId on insert (only single tenantId, consistent with save hook)
        if (tenantId && !op.insertOne.document.tenantId) {
          op.insertOne.document.tenantId = tenantId;
        }
      } else if ('updateOne' in op) {
        op.updateOne.filter = { ...op.updateOne.filter, ...filter };
      } else if ('updateMany' in op) {
        op.updateMany.filter = { ...op.updateMany.filter, ...filter };
      } else if ('replaceOne' in op) {
        op.replaceOne.filter = { ...op.replaceOne.filter, ...filter };
      } else if ('deleteOne' in op) {
        op.deleteOne.filter = { ...op.deleteOne.filter, ...filter };
      } else if ('deleteMany' in op) {
        op.deleteMany.filter = { ...op.deleteMany.filter, ...filter };
      }
    }
  });

  // === Aggregate: prepend $match stage ===
  schema.pre('aggregate', function () {
    // Aggregate hooks: `this` is the Aggregation pipeline — the model is on the internal `_model` property
    const modelName = (this as any)._model?.modelName;
    const filter = resolveTenantFilter(modelName);
    if (filter !== undefined) {
      this.pipeline().unshift({ $match: filter });
    }
  });
}

/**
 * Check common bypass conditions.
 *
 * @returns `true` if filtering should be skipped, `false` otherwise
 */
function shouldBypass(modelName?: string): boolean {
  const mtConfig = ConfigService.configFastButReadOnly?.multiTenancy;
  if (!mtConfig || mtConfig.enabled === false) return true;

  const context = RequestContext.get();
  if (!context) return true;
  if (context.bypassTenantGuard) return true;
  if (modelName && mtConfig.excludeSchemas?.includes(modelName)) return true;

  return false;
}

/**
 * Resolve tenant filter from RequestContext for read operations (queries, aggregates).
 *
 * @returns
 * - `undefined` → no filter should be applied
 * - `{ tenantId: string }` → filter by single tenant (header set)
 * - `{ tenantId: { $in: string[] } }` → filter by user's tenant memberships (no header)
 */
function resolveTenantFilter(modelName?: string): Record<string, any> | undefined {
  if (shouldBypass(modelName)) return undefined;

  const context = RequestContext.get();
  const tenantId = context?.tenantId;

  // Specific tenant header → filter by it
  if (tenantId) return { tenantId };

  // No header but user has resolved memberships → filter by their tenants
  const tenantIds = context?.tenantIds;
  if (tenantIds) return { tenantId: { $in: tenantIds } };

  // No header, no user / no memberships → no filter
  return undefined;
}

/**
 * Resolve single tenant ID for write operations (save, insertMany).
 * Only returns a value when a specific tenant header is set.
 */
function resolveSingleTenantId(modelName?: string): string | undefined {
  if (shouldBypass(modelName)) return undefined;

  return RequestContext.get()?.tenantId || undefined;
}
