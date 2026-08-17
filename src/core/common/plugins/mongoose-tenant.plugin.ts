import { ForbiddenException } from '@nestjs/common';

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
  // Only activate on schemas with a tenantId path.
  // CoreTenantMemberModel uses 'tenant' (not 'tenantId') intentionally, so this check
  // excludes it at registration time. Additionally, 'TenantMember' is auto-added to
  // excludeSchemas in CoreModule as defense-in-depth (see shouldBypass()).
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

  // === estimatedDocumentCount: unfilterable, so refuse it inside a tenant context ===
  //
  // It reads collection metadata rather than running a query, so MongoDB ignores any filter — there
  // is nothing to inject. Returning it unchanged would hand a tenant the row count of the WHOLE
  // collection, i.e. every other tenant's volume. Throwing is the only honest option; callers that
  // want a tenant's own count use countDocuments(), which IS filtered.
  schema.pre('estimatedDocumentCount', function () {
    const modelName = (this as any).model?.modelName;
    if (shouldBypass(modelName)) {
      return;
    }
    const context = RequestContext.get();
    if (context?.isAdminBypass && !context?.tenantId) {
      return; // platform admin without a tenant header legitimately sees everything
    }
    throw new ForbiddenException(
      "estimatedDocumentCount() cannot be tenant-filtered and would expose other tenants' row counts — " +
        'use countDocuments() instead',
    );
  });

  // === Aggregate: prepend $match stage, and secure every cross-collection stage ===
  schema.pre('aggregate', function () {
    // Aggregate hooks: `this` is the Aggregation pipeline — the model is on the internal `_model` property
    const model = (this as any)._model;
    const modelName = model?.modelName;
    const filter = resolveTenantFilter(modelName);
    if (filter === undefined) {
      return;
    }

    const pipeline = this.pipeline();
    pipeline.unshift({ $match: filter });

    // The $match above only constrains the SOURCE collection. `$lookup`, `$unionWith` and
    // `$graphLookup` read a DIFFERENT collection, and that collection's own `aggregate` hook never
    // fires — the join runs inside this pipeline. Without the pass below, a single aggregation
    // returns every tenant's rows from the joined collection, which is exactly the shape a
    // reporting query takes.
    secureCrossCollectionStages(pipeline, model);
  });
}

/**
 * Inject the tenant filter into every stage that reads another collection.
 *
 * Recurses, because these stages nest: a `$lookup.pipeline` may itself contain a `$lookup`, and
 * `$facet` holds a sub-pipeline per key.
 *
 * A joined collection is only constrained when it is itself tenant-scoped (its model has a
 * `tenantId` path and is not excluded). Joining a global lookup table stays untouched — filtering
 * it by `tenantId` would silently return nothing.
 */
function secureCrossCollectionStages(pipeline: any[], model: any): void {
  if (!Array.isArray(pipeline)) {
    return;
  }

  for (const stage of pipeline) {
    if (!stage || typeof stage !== 'object') {
      continue;
    }

    if (stage.$lookup) {
      const filter = filterForCollection(stage.$lookup.from, model);
      if (filter) {
        // MongoDB 5.0+ allows `pipeline` alongside localField/foreignField, so this works for the
        // concise join form too, not only the explicit-pipeline one.
        stage.$lookup.pipeline = [{ $match: filter }, ...(stage.$lookup.pipeline ?? [])];
      }
      secureCrossCollectionStages(stage.$lookup.pipeline, model);
    }

    if (stage.$unionWith) {
      // Two forms: `$unionWith: 'coll'` and `$unionWith: { coll, pipeline }`.
      if (typeof stage.$unionWith === 'string') {
        const filter = filterForCollection(stage.$unionWith, model);
        if (filter) {
          stage.$unionWith = { coll: stage.$unionWith, pipeline: [{ $match: filter }] };
        }
      } else {
        const filter = filterForCollection(stage.$unionWith.coll, model);
        if (filter) {
          stage.$unionWith.pipeline = [{ $match: filter }, ...(stage.$unionWith.pipeline ?? [])];
        }
        secureCrossCollectionStages(stage.$unionWith.pipeline, model);
      }
    }

    if (stage.$graphLookup) {
      const filter = filterForCollection(stage.$graphLookup.from, model);
      if (filter) {
        // $graphLookup takes no pipeline; `restrictSearchWithMatch` is its filter hook and applies
        // to EVERY recursive step, which is what a traversal needs.
        stage.$graphLookup.restrictSearchWithMatch = {
          ...stage.$graphLookup.restrictSearchWithMatch,
          ...filter,
        };
      }
    }

    if (stage.$facet && typeof stage.$facet === 'object') {
      for (const branch of Object.values(stage.$facet)) {
        secureCrossCollectionStages(branch as any[], model);
      }
    }
  }
}

/**
 * Tenant filter for a JOINED collection, or `undefined` when none applies.
 *
 * Resolves the collection name back to its model so the same "is this tenant-scoped?" rule applies
 * as for a direct query. An unknown collection name yields no filter: the plugin cannot tell
 * whether it is tenant-scoped, and inventing a `tenantId` constraint for a collection that has no
 * such field would turn a working join into an empty result.
 */
function filterForCollection(collectionName: unknown, sourceModel: any): Record<string, any> | undefined {
  if (typeof collectionName !== 'string' || !collectionName) {
    return undefined;
  }

  const models = sourceModel?.db?.models ?? {};
  for (const name of Object.keys(models)) {
    const candidate = models[name];
    if (candidate?.collection?.name !== collectionName) {
      continue;
    }
    if (!candidate.schema?.path('tenantId')) {
      return undefined; // not tenant-scoped — leave the join alone
    }
    const filter = resolveTenantFilter(name);
    // `{}` means "admin bypass, sees everything" — nothing to inject.
    return filter && Object.keys(filter).length ? filter : undefined;
  }

  return undefined;
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
 * Defense-in-depth: If a schema has tenantId but there is no valid tenant context,
 * throws ForbiddenException instead of returning unfiltered data (Safety Net).
 *
 * @returns
 * - `undefined` → no filter should be applied (bypass active or plugin disabled)
 * - `{}` → empty filter (admin bypass without header — sees all data)
 * - `{ tenantId: string }` → filter by single validated tenant
 * - `{ tenantId: { $in: string[] } }` → filter by user's tenant memberships
 * @throws ForbiddenException when tenantId-schema is accessed without valid tenant context
 */
function resolveTenantFilter(modelName?: string): Record<string, any> | undefined {
  if (shouldBypass(modelName)) return undefined;

  const context = RequestContext.get();

  // Validated tenant ID (set by CoreTenantGuard) → filter by it
  const tenantId = context?.tenantId;
  if (tenantId) return { tenantId };

  // User has resolved memberships → filter by their tenants
  const tenantIds = context?.tenantIds;
  if (tenantIds) return { tenantId: { $in: tenantIds } };

  // Admin bypass without header → no filter, sees all data
  if (context?.isAdminBypass) return {};

  // SAFETY NET: Schema has tenantId but no valid tenant context.
  // Throw instead of returning unfiltered data to prevent data leaks.
  throw new ForbiddenException(
    'Tenant context required: this data is tenant-scoped but no valid tenant context was provided',
  );
}

/**
 * Resolve single tenant ID for write operations (save, insertMany).
 * Only returns a value when a specific tenant header is set.
 */
function resolveSingleTenantId(modelName?: string): string | undefined {
  if (shouldBypass(modelName)) return undefined;

  return RequestContext.get()?.tenantId || undefined;
}
