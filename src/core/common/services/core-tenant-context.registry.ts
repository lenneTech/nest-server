/**
 * How a non-HTTP transport asks the tenant machinery "which tenant is this caller in?".
 *
 * DELIBERATELY IMPORT-FREE apart from a type-only import, so it stays a leaf — and it lives under
 * `src/core/common/` rather than next to the tenant module for a second reason: the reader is
 * `graphql-ws-context.helper`, also in `src/core/common/`, and `src/core/common/**` must not import
 * from `src/core/modules/**`. The writer (`CoreTenantGuard`) imports in the allowed direction.
 * A registry rather than DI because the GraphQL wiring in `core.module.ts` must not depend on a
 * provider that only exists when multi-tenancy is configured. Same pattern as
 * `core-cron-jobs.registry.ts`. See `.claude/rules/architecture.md` → "DI Token Placement (SWC-Safe)".
 *
 * WHY IT EXISTS: `CoreTenantGuard` answers this question from an Express request and writes the
 * answer onto it (`request.tenantId` / `request.tenantIds`), which `RequestContextMiddleware` then
 * exposes through AsyncLocalStorage. A WebSocket never traverses either — no Express middleware runs
 * on an upgrade, and the guard's own `getRequest()` returns nothing for a subscription context, so it
 * returns `true` without deciding anything. This registry is what lets the WebSocket path ask the
 * same question through the same membership logic and cache.
 */
import type { IRequestContext } from './request-context.service';

/** The tenant-relevant slice of a request context — everything the Mongoose tenant plugin reads. */
export type ResolvedTenantContext = Pick<IRequestContext, 'isAdminBypass' | 'tenantId' | 'tenantIds' | 'tenantRole'>;

export interface TenantContextResolver {
  /**
   * @param user the authenticated user (with `roles`), or undefined for an anonymous caller
   * @param headerTenantId the raw tenant id the transport carried, if any — NEVER trusted; it is
   *   validated against an active membership before it is returned
   */
  resolve(user: { id: string; roles?: string[] } | undefined, headerTenantId?: string): Promise<ResolvedTenantContext>;
}

let resolver: TenantContextResolver | undefined;

/** Registered by `CoreTenantGuard` on init. Idempotent — test fixtures build the guard repeatedly. */
export function setTenantContextResolver(next: TenantContextResolver | undefined): void {
  resolver = next;
}

/**
 * The registered resolver, or `undefined` when multi-tenancy is not in play.
 *
 * `undefined` must NOT be read as "no tenant restrictions": it means nothing can answer the
 * question, so a caller establishes a context WITHOUT tenant information and lets the Mongoose
 * plugin's safety net refuse tenant-scoped reads. That is the difference between "this data is not
 * tenant-scoped" and "nobody knows which tenant this is".
 */
export function getTenantContextResolver(): TenantContextResolver | undefined {
  return resolver;
}
