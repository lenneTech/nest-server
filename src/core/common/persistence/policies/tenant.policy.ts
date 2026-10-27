import { ForbiddenException, Logger } from '@nestjs/common';

import { ConfigService } from '../../services/config.service.js';
import { RequestContext } from '../../services/request-context.service.js';

/**
 * Tenant isolation decisions, shared by every data store.
 *
 * `mongooseTenantPlugin` applies them to Mongoose queries; a SQL store applies the same functions to its
 * statements. A security fix therefore lands here once and reaches every database. The returned filters
 * are neutral `Where` objects (`{ tenantId }`, `{ tenantId: { $in } }`) — the Mongo-operator subset every
 * store understands.
 */

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
export function assertOwnTenant(value: unknown, ownTenantId: string, isNew: boolean): void {
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
 * Whether tenant isolation is off for this operation: multi-tenancy not configured, no request context
 * (system work: cron, migration, seed), an active `runWithBypassTenantGuard()`, or the model listed in
 * `excludeSchemas`.
 *
 * @returns `true` if filtering should be skipped, `false` otherwise
 */
export function isTenantPolicyBypassed(modelName?: string): boolean {
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
export function resolveTenantFilter(modelName?: string): Record<string, any> | undefined {
  if (isTenantPolicyBypassed(modelName)) return undefined;

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
export function resolveSingleTenantId(modelName?: string): string | undefined {
  if (isTenantPolicyBypassed(modelName)) return undefined;

  return RequestContext.get()?.tenantId || undefined;
}

/**
 * The tenants whose rows the current operation may return, or `undefined` when it may return all of them
 * (isolation bypassed, or a platform admin without a tenant header) — the same decision the read filter
 * is built from.
 */
export function allowedTenantIds(modelName?: string): readonly string[] | undefined {
  if (isTenantPolicyBypassed(modelName)) return undefined;

  const context = RequestContext.get();
  if (context?.tenantId) return [context.tenantId];
  if (context?.tenantIds) return context.tenantIds;
  if (context?.isAdminBypass) return undefined;
  return [];
}

/**
 * The after-layer of tenant isolation: refuse a result that contains a row of a tenant the caller may not
 * read.
 *
 * The read filter (`resolveTenantFilter()`) already keeps such rows out, so on a correct path this never
 * fires — it exists for the paths where the filter is not what decides: a query compiled for another
 * database, a join, a native path, a filter built with the wrong scope. Rows that do not carry the field
 * at all (a projection left it out) cannot be verified and pass; the filter applied to them regardless.
 *
 * @throws ForbiddenException naming the model, never the foreign tenant's id
 */
export function assertRowsInTenantScope(modelName: string | undefined, rows: unknown): void {
  const allowed = allowedTenantIds(modelName);
  if (!allowed) {
    return;
  }
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    const tenantId = (row as { tenantId?: unknown }).tenantId;
    if (tenantId === undefined) {
      continue;
    }
    if (tenantId === null || !allowed.includes(String(tenantId))) {
      new Logger('TenantIsolation').error(
        `A read of "${modelName ?? 'unknown model'}" returned a row of a tenant outside the caller's scope — ` +
          'the read filter did not hold on this path; the result was withheld',
      );
      throw new ForbiddenException('Tenant isolation: the result contains data of another tenant');
    }
  }
}

/**
 * Refuse a count that cannot be tenant-filtered (MongoDB's `estimatedDocumentCount()`, a SQL
 * planner estimate): it reads collection metadata rather than running a query, so it would hand a
 * tenant the row count of the WHOLE collection, i.e. every other tenant's volume. Callers that want a
 * tenant's own count use a filtered count instead.
 */
export function assertUnfilterableCountAllowed(modelName?: string): void {
  if (isTenantPolicyBypassed(modelName)) {
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
}
