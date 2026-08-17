import { ForbiddenException, Logger } from '@nestjs/common';

import { ConfigService } from '../services/config.service';
import { RequestContext } from '../services/request-context.service';

/** Models already warned about, so the message appears once per process rather than per query. */
const isolationDisabledWarned = new Set<string>();

/**
 * Say out loud that isolation is off for a schema that was built for it.
 *
 * `excludeSchemas` is a legitimate feature — a genuinely global lookup table has no tenant. But this
 * plugin only ever attaches to schemas that DECLARE a `tenantId` field, so reaching here means the
 * author of that schema intended per-tenant rows and the configuration silently overrides them.
 * Nothing said so, and the shape is easy to arrive at by accident: the framework's own documentation
 * carried `excludeSchemas: ['User', 'Session']` in a copyable `@example` from 11.20.0 onwards, which
 * on a project with per-tenant users switches filtering off for the user collection.
 *
 * A warning, not a boot failure. An ambiguous ROLE vocabulary fails the boot because its access
 * decisions cannot be resolved coherently; this configuration is perfectly coherent — it is simply
 * one nobody may make without noticing.
 *
 * The membership model is skipped: `CoreModule` adds it to `excludeSchemas` itself because
 * membership is tenant-spanning by design, so warning about it would be the framework complaining
 * about its own correct default.
 */
function warnIsolationDisabled(modelName: string): void {
  if (isolationDisabledWarned.has(modelName)) {
    return;
  }
  isolationDisabledWarned.add(modelName);

  const membershipModel = ConfigService.configFastButReadOnly?.multiTenancy?.membershipModel ?? 'TenantMember';
  if (modelName === membershipModel) {
    return;
  }

  new Logger('mongooseTenantPlugin').warn(
    `Tenant isolation is DISABLED for "${modelName}": the schema declares a tenantId field, but ` +
      `"${modelName}" is listed in multiTenancy.excludeSchemas — so no tenant filter is applied and ` +
      `every query on it sees every tenant's rows. Remove it from excludeSchemas unless this ` +
      `collection is genuinely global.`,
  );
}

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

      // The filter above constrains WHICH rows are touched, never what the update WRITES. So a
      // caller could legitimately match their own row and then rewrite its tenantId — moving it
      // into a tenant they control, or simply out of reach of its rightful owner.
      const single = resolveSingleTenantId(modelName);
      if (single) {
        const update: any = typeof this.getUpdate === 'function' ? this.getUpdate() : undefined;
        for (const candidate of [update?.tenantId, update?.$set?.tenantId, update?.$setOnInsert?.tenantId]) {
          if (candidate !== undefined) {
            assertOwnTenant(candidate, single, false);
          }
        }
      }
    });
  }

  // === Save: set tenantId automatically on new documents ===
  // Intentional asymmetry: writes only set tenantId when truthy (not null).
  // Only uses single tenantId from header — tenantIds array is for reads only.
  schema.pre('save', function () {
    // Document hooks: `this` is the document instance — modelName is on the constructor (the Model class)
    const modelName = (this.constructor as any).modelName;
    const tenantId = resolveSingleTenantId(modelName);
    if (!tenantId) {
      return;
    }

    if (this.isNew && !this['tenantId']) {
      this['tenantId'] = tenantId;
      return;
    }

    // A tenantId that is already on the document did NOT come from this hook. Stamping only when
    // absent is right for system writes, but on its own it means a caller-supplied value survives —
    // so an explicit foreign tenantId would place the row in someone else's tenant, and modifying it
    // on an existing document would move the row out of this one.
    assertOwnTenant(this['tenantId'], tenantId, this.isNew);
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
        } else {
          assertOwnTenant(doc.tenantId, tenantId, true);
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

    // $out and $merge are the only aggregation stages that WRITE, and neither can be constrained
    // the way a read stage can: $out REPLACES a whole collection, and $merge writes rows whose
    // tenantId comes from the pipeline rather than from the caller's context. Either one turns an
    // aggregation into a way to launder rows across the boundary — or, with $out, to erase another
    // tenant's collection outright. There is nothing to inject here, so a tenant-scoped caller is
    // refused; system code that legitimately needs them runs under runWithBypassTenantGuard().
    const writeStage = pipeline.find((stage: any) => stage && (stage.$out !== undefined || stage.$merge !== undefined));
    if (writeStage) {
      throw new ForbiddenException(
        `Aggregation write stages ($out / $merge) are not permitted inside a tenant context — ` +
          'they cannot be tenant-filtered. Run them as a system operation if this is intended.',
      );
    }

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
 * Refuse a tenantId that is not the caller's own.
 *
 * Covers both directions of the same boundary:
 * - creating a row with a FOREIGN tenantId → planting data in someone else's tenant;
 * - changing an existing row's tenantId → moving data out of this one.
 *
 * Throwing rather than overwriting is deliberate. Silently rewriting the value would make a request
 * that asked for something impossible look like it succeeded, and for tenant-scoped medical data
 * "the write went somewhere other than you asked" is not a recoverable ambiguity.
 */
function assertOwnTenant(value: unknown, ownTenantId: string, isNew: boolean): void {
  if (value === undefined || value === null || value === ownTenantId) {
    return;
  }
  throw new ForbiddenException(
    isNew
      ? `Cannot create a document in a foreign tenant (got "${String(value)}", own tenant is "${ownTenantId}")`
      : `Cannot move a document to a foreign tenant (got "${String(value)}", own tenant is "${ownTenantId}")`,
  );
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
  if (modelName && mtConfig.excludeSchemas?.includes(modelName)) {
    warnIsolationDisabled(modelName);
    return true;
  }

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
