import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { RoleEnum } from '../../common/enums/role.enum';
import { ConfigService } from '../../common/services/config.service';
import { CoreTenantMemberModel } from './core-tenant-member.model';
import { SKIP_TENANT_CHECK_KEY } from './core-tenant.decorators';
import { TENANT_MEMBER_MODEL_TOKEN, TenantMemberStatus } from './core-tenant.enums';
import {
  checkRoleAccess,
  getMinRequiredLevel,
  getRoleHierarchy,
  isSystemRole,
  mergeRolesMetadata,
} from './core-tenant.helpers';

/**
 * Cached membership entry with TTL
 */
interface CachedMembership {
  expiresAt: number;
  result: CoreTenantMemberModel | null;
}

/**
 * Cached tenant IDs entry with TTL
 */
interface CachedTenantIds {
  expiresAt: number;
  ids: string[];
}

/**
 * Global guard for multi-tenancy with defense-in-depth security.
 *
 * Only registered as APP_GUARD when multiTenancy is active.
 * Runs after auth guards to validate tenant membership and role access.
 *
 * This guard is responsible for ALL non-system role checks when multiTenancy is active.
 * RolesGuard passes through non-system roles to this guard.
 *
 * Security model:
 * - Guard level: Membership validation, admin bypass, role checks (hierarchy + normal)
 * - Plugin level: Safety net — ForbiddenException when tenantId-schema accessed without context
 *
 * Role check semantics:
 * - System roles are OR alternatives, checked in order before real roles:
 *   S_EVERYONE → immediate pass; S_USER → pass if authenticated; S_VERIFIED → pass if verified
 * - When a system role grants access and X-Tenant-Id header is present, membership is still
 *   validated to set tenant context (tenantId + tenantRole) on the request.
 * - Hierarchy roles (in roleHierarchy config): level comparison — higher includes lower
 * - Normal roles (not in roleHierarchy): exact match — no compensation by higher role
 * - Tenant context (header present): checks against membership.role only (user.roles ignored)
 * - No tenant context: checks against user.roles
 *
 * BetterAuth (IAM) auto-skip behavior (skipTenantCheck config, default: true):
 * - No X-Tenant-Id header: skip tenant validation entirely (auth before tenant is the expected case)
 * - X-Tenant-Id header IS present: fall through to normal validation (membership check + context)
 * This allows tenant-aware auth flows (subdomain-based, invite links, etc.) to coexist with
 * the default cross-tenant behavior. The tenant is optional but respected when provided.
 *
 * Flow:
 * 1. Config check: multiTenancy enabled?
 * 2. Parse header (X-Tenant-Id, max 128 chars, trimmed)
 * 3. Read @Roles() metadata (method + class level)
 * 4. System role early-exit checks (OR alternatives):
 *    S_EVERYONE → pass immediately
 *    S_USER → pass if authenticated (+ optional membership check when header present)
 *    S_VERIFIED → pass if user is verified (+ optional membership check when header present)
 * 5. @SkipTenantCheck → role check against user.roles, no tenant context
 * 6. BetterAuth auto-skip (betterAuth.skipTenantCheck config + no header) → skip, no tenant context
 *
 * HEADER PRESENT:
 *   - System ADMIN (adminBypass: true) → set req.tenantId + isAdminBypass
 *   - No user → 403 "Authentication required for tenant access"
 *   - Authenticated non-admin user:
 *     - Active member → checkRoleAccess against membership.role → set req.tenantId + tenantRole
 *     - Not active member → ALWAYS 403
 *
 * NO HEADER:
 *   - System ADMIN → set isAdminBypass (sees all data)
 *   - Authenticated + checkable roles → checkRoleAccess against user.roles
 *     → resolveUserTenantIds with minLevel filter
 *   - Authenticated + no checkable roles → resolveUserTenantIds (all memberships)
 *   - No user + no checkable roles → pass (plugin safety net catches tenantId-schema access)
 *   - No user + checkable roles → 403 "Authentication required"
 */
@Injectable()
export class CoreTenantGuard implements CanActivate, OnModuleDestroy {
  private readonly logger = new Logger(CoreTenantGuard.name);

  /**
   * In-memory TTL cache for membership lookups.
   * Key: `${userId}:${tenantId}`, Value: cached membership result with expiry.
   * Eliminates repeated DB queries for the same user+tenant combination.
   */
  private readonly membershipCache = new Map<string, CachedMembership>();

  /**
   * In-memory TTL cache for tenant ID resolution (no-header path).
   * Key: `${userId}` or `${userId}:${minLevel}`, Value: cached tenant IDs with expiry.
   */
  private readonly tenantIdsCache = new Map<string, CachedTenantIds>();

  /** Cache TTL in milliseconds. Configurable via multiTenancy.cacheTtlMs (default: 30s, 0 = disabled) */
  private cacheTtlMs: number = 30_000;
  /** Maximum cache entries before eviction */
  private static readonly MAX_CACHE_SIZE = 500;
  /** Cleanup interval handle */
  private cleanupInterval: NodeJS.Timeout | null = null;
  /** Tracks the last seen config reference to detect config changes (e.g., roleHierarchy) */
  private lastSeenConfig: object | null = null;

  constructor(
    private readonly reflector: Reflector,
    @InjectModel(TENANT_MEMBER_MODEL_TOKEN) private readonly memberModel: Model<CoreTenantMemberModel>,
  ) {
    // Clean up expired cache entries every 60 seconds
    this.cleanupInterval = setInterval(() => this.evictExpired(), 60_000);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.membershipCache.clear();
    this.tenantIdsCache.clear();
  }

  /**
   * Invalidate all cache entries for a specific user.
   * Call this when memberships change (add/remove/update).
   *
   * Note: userId must not contain ':' characters (used as cache key delimiter).
   * MongoDB ObjectIds and standard UUID formats are safe.
   *
   * @param userId - The user ID whose cache entries should be invalidated
   */
  invalidateUser(userId: string): void {
    for (const key of this.membershipCache.keys()) {
      if (key.startsWith(`${userId}:`)) {
        this.membershipCache.delete(key);
      }
    }
    for (const key of this.tenantIdsCache.keys()) {
      if (key === userId || key.startsWith(`${userId}:`)) {
        this.tenantIdsCache.delete(key);
      }
    }
  }

  /**
   * Clear all cache entries.
   * Useful when configuration changes (e.g., roleHierarchy) or for testing.
   */
  invalidateAll(): void {
    this.membershipCache.clear();
    this.tenantIdsCache.clear();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = ConfigService.configFastButReadOnly?.multiTenancy;
    if (!config || config.enabled === false) {
      return true;
    }

    // Detect config changes (e.g., roleHierarchy modified in tests) and flush caches
    if (this.lastSeenConfig !== config) {
      this.lastSeenConfig = config;
      // Default 30s in production, 0 (disabled) in test environments to avoid stale data between test cases
      const isTestEnv =
        process.env.VITEST === 'true' || process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'e2e';
      this.cacheTtlMs = config.cacheTtlMs ?? (isTestEnv ? 0 : 30_000);
      this.invalidateAll();
    }

    const request = this.getRequest(context);
    if (!request) {
      return true;
    }

    // Parse tenant header
    const headerName = (config.headerName ?? 'x-tenant-id').toLowerCase();
    const rawHeader = request.headers?.[headerName] as string | undefined;
    const headerTenantId =
      rawHeader && typeof rawHeader === 'string' && rawHeader.length <= 128 ? rawHeader.trim() : undefined;

    // Two role sets for different purposes:
    //
    // 1. systemCheckRoles (method-takes-precedence): Used for system role early-returns.
    //    Method-level system roles override class-level ones to prevent e.g. class @Roles(S_EVERYONE)
    //    from making a method @Roles(S_USER) endpoint public.
    //
    // 2. roles (OR/merged): Used for real role checks (checkableRoles).
    //    Class-level roles serve as a base that method-level roles extend.
    //    E.g., class @Roles(ADMIN) + method @Roles('editor') → both are alternatives.
    //
    // S_EVERYONE check — access is always granted; no authentication or membership required.
    //
    // Header handling for S_EVERYONE:
    //   - No header → return true immediately (no tenant context needed)
    //   - Header present + authenticated user that IS a member → optionally enrich with tenant
    //     context (sets request.tenantId/tenantRole) so downstream consumers can use it.
    //     Access is NOT blocked if user is not a member — S_EVERYONE means public access.
    const rolesMetadata = this.reflector.getAll<string[][]>('roles', [context.getHandler(), context.getClass()]);
    const roles = mergeRolesMetadata(rolesMetadata);
    const methodRoles: string[] = rolesMetadata[0] ?? [];
    const systemCheckRoles = methodRoles.length > 0 ? methodRoles : roles;

    // Defense-in-depth: S_NO_ONE is normally caught by RolesGuard/BetterAuthRolesGuard upstream,
    // but guard it here too in case CoreTenantGuard runs standalone (e.g., custom guard chains).
    if (roles.includes(RoleEnum.S_NO_ONE)) {
      throw new ForbiddenException('Access denied');
    }

    const sEveryoneGrantsAccess: boolean = systemCheckRoles.includes(RoleEnum.S_EVERYONE);
    if (sEveryoneGrantsAccess) {
      // Optionally enrich with tenant context when header is present and user is an active member.
      // Never block access — S_EVERYONE endpoints are always public.
      if (headerTenantId && request.user?.id) {
        const membership = await this.findMembershipCached(request.user.id, headerTenantId);
        if (membership) {
          request.tenantId = headerTenantId;
          request.tenantRole = membership.role as string;
        }
      }
      return true;
    }

    const user = request.user;
    const adminBypass = config.adminBypass !== false;
    const isAdmin = adminBypass && user?.roles?.includes(RoleEnum.ADMIN);

    // Read @SkipTenantCheck early — it suppresses tenant membership validation for system roles too.
    // When set, S_USER and S_VERIFIED still enforce authentication/verification, but no membership
    // check is performed even when a tenant header is present.
    const hasSkipDecorator = this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_CHECK_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // S_USER check — any authenticated user satisfies this system role.
    //
    // OR semantics: if S_USER is in the active role set, a logged-in user gets through.
    // Real roles in the same @Roles() are ignored when S_USER is satisfied (they are alternatives).
    // Example: @Roles(S_USER, 'owner') → a plain logged-in user passes (owner is an alternative, not required).
    //
    // Tenant header behavior: when X-Tenant-Id is present and @SkipTenantCheck is NOT set,
    // membership is validated so that tenant context (tenantId, tenantRole) is set on the request.
    // A non-member will still get 403 when a tenant header is provided (unless @SkipTenantCheck).
    const sUserGrantsAccess: boolean = systemCheckRoles.includes(RoleEnum.S_USER);
    if (sUserGrantsAccess) {
      if (!user) {
        throw new ForbiddenException('Authentication required');
      }
      if (headerTenantId && !hasSkipDecorator) {
        return this.handleSystemRoleWithTenantHeader(user, headerTenantId, request, isAdmin);
      }
      return true;
    }

    // S_VERIFIED check — any verified authenticated user satisfies this system role.
    //
    // A user is considered verified when any of these properties is truthy:
    //   user.verified, user.verifiedAt, user.emailVerified
    //
    // Tenant header behavior: same as S_USER — membership is validated when header is present
    // (unless @SkipTenantCheck is set).
    const sVerifiedGrantsAccess: boolean = systemCheckRoles.includes(RoleEnum.S_VERIFIED);
    if (sVerifiedGrantsAccess) {
      if (!user) {
        throw new ForbiddenException('Authentication required');
      }
      const isVerified = !!(user.verified || user.verifiedAt || user.emailVerified);
      if (!isVerified) {
        throw new ForbiddenException('Verification required');
      }
      if (headerTenantId && !hasSkipDecorator) {
        return this.handleSystemRoleWithTenantHeader(user, headerTenantId, request, isAdmin);
      }
      return true;
    }

    // Extract checkable (non-system) roles from the merged set.
    // System roles that grant access (S_EVERYONE, S_USER, S_VERIFIED) have been
    // early-returned above. Remaining system roles (S_SELF, S_CREATOR) are object-level
    // and handled by interceptors.
    const checkableRoles = roles.filter((r: string) => !isSystemRole(r));

    const minRequiredLevel = checkableRoles.length > 0 ? getMinRequiredLevel(checkableRoles) : undefined;

    // @SkipTenantCheck decorator → no tenant context, but role check against user.roles
    if (hasSkipDecorator) {
      return this.skipWithUserRoleCheck(checkableRoles, user, isAdmin);
    }

    // Auto-skip tenant check for BetterAuth (IAM) handlers when configured,
    // but ONLY when no X-Tenant-Id header is present.
    // - No header: skip tenant validation (auth before tenant is the expected case for most projects)
    // - Header present: fall through to normal validation (membership check, tenant context set)
    // This allows tenant-aware auth scenarios to coexist with the default cross-tenant behavior.
    // Default config: betterAuth.skipTenantCheck = true (note: distinct from @SkipTenantCheck decorator above).
    if (!hasSkipDecorator && !headerTenantId && this.isBetterAuthHandler(context)) {
      const betterAuthConfig = ConfigService.configFastButReadOnly?.betterAuth;
      // Boolean shorthand: `betterAuth: true` → skip, `betterAuth: false` → no skip
      const shouldSkip =
        betterAuthConfig !== null && betterAuthConfig !== undefined && typeof betterAuthConfig === 'object'
          ? betterAuthConfig.skipTenantCheck !== false // default: true
          : betterAuthConfig !== false; // true/undefined → skip; false → no skip

      if (shouldSkip) {
        this.logger.debug(
          `BetterAuth auto-skip: ${context.getClass().name}::${context.getHandler().name} — no X-Tenant-Id header, skipping tenant validation`,
        );
        return this.skipWithUserRoleCheck(checkableRoles, user, isAdmin);
      }
    }

    // === HEADER PRESENT ===
    if (headerTenantId) {
      // Admin bypass: set req.tenantId so plugin filters (read by RequestContextMiddleware
      // lazy getter → context.tenantId, also consumed by @CurrentTenant() via RequestContext)
      if (isAdmin) {
        request.tenantId = headerTenantId;
        request.isAdminBypass = true;
        const requiredRole = checkableRoles.length > 0 ? checkableRoles.join(',') : 'none';
        // Sanitize control characters to prevent log injection
        const safeTenantId = headerTenantId.replace(/[\r\n\t]/g, '_');
        this.logger.debug(`Admin bypass: user ${user.id} accessing tenant ${safeTenantId} (required: ${requiredRole})`);
        return true;
      }

      // No user + header → 403 (tenant access requires authentication)
      if (!user) {
        throw new ForbiddenException('Authentication required for tenant access');
      }

      // Authenticated non-admin user: MUST be active member
      const membership = await this.findMembershipCached(user.id, headerTenantId);

      if (!membership) {
        throw new ForbiddenException('Not a member of this tenant');
      }

      const memberRole = membership.role as string;

      // Check role access if roles are required (hierarchy + normal, against membership.role)
      if (checkableRoles.length > 0) {
        if (!checkRoleAccess(checkableRoles, undefined, memberRole)) {
          throw new ForbiddenException('Insufficient tenant role');
        }
      }

      // Set validated tenant context on request (consumed by RequestContextMiddleware
      // lazy getter → context.tenantId / context.tenantRole, and by @CurrentTenant() via RequestContext)
      request.tenantId = headerTenantId;
      request.tenantRole = memberRole;
      return true;
    }

    // === NO HEADER ===

    // Admin without header → sees all data
    if (isAdmin) {
      request.isAdminBypass = true;
      return true;
    }

    // Checkable roles present
    if (checkableRoles.length > 0) {
      // No user + roles required → 403
      if (!user) {
        throw new ForbiddenException('Authentication required');
      }

      // Check role access against user.roles (hierarchy: level comparison, normal: exact match)
      if (!checkRoleAccess(checkableRoles, user.roles, undefined)) {
        throw new ForbiddenException('Insufficient role');
      }

      // Resolve tenant IDs filtered by minimum required hierarchy level
      await this.resolveUserTenantIds(request, minRequiredLevel);
      return true;
    }

    // Authenticated user without header and no checkable roles: resolve their tenant memberships
    // so the plugin can filter by { tenantId: { $in: tenantIds } }
    if (user) {
      await this.resolveUserTenantIds(request);
    }

    return true;
  }

  /**
   * Look up all active tenant memberships for the user and store them on the request.
   * This allows the tenant plugin to filter by { tenantId: { $in: tenantIds } }
   * when no specific tenant header is set.
   *
   * Uses a process-level TTL cache to avoid repeated DB queries for the same user.
   *
   * @param minLevel - When set, only include memberships where role level >= minLevel
   */
  private async resolveUserTenantIds(request: any, minLevel?: number): Promise<void> {
    // Skip if already resolved on this request
    if (request.tenantIds) {
      return;
    }

    const userId = request.user.id;
    const ttl = this.cacheTtlMs;

    // When cache is enabled, check process-level cache
    if (ttl > 0) {
      const cacheKey = minLevel !== undefined ? `${userId}:${minLevel}` : userId;
      const now = Date.now();
      const cached = this.tenantIdsCache.get(cacheKey);
      if (cached && now < cached.expiresAt) {
        request.tenantIds = cached.ids;
        return;
      }
    }

    const memberships = await this.memberModel
      .find({
        status: TenantMemberStatus.ACTIVE,
        user: userId,
      })
      .select('tenant role')
      .lean()
      .exec();

    let ids: string[];
    if (minLevel !== undefined) {
      const hierarchy = getRoleHierarchy();
      ids = memberships
        .filter((m) => {
          const level = hierarchy[m.role as string] ?? 0;
          return level >= minLevel;
        })
        .map((m) => m.tenant as string);
    } else {
      ids = memberships.map((m) => m.tenant as string);
    }

    request.tenantIds = ids;

    // Store in process-level cache when enabled
    if (ttl > 0) {
      const cacheKey = minLevel !== undefined ? `${userId}:${minLevel}` : userId;
      this.evictIfOverCapacity(this.tenantIdsCache);
      this.tenantIdsCache.set(cacheKey, { expiresAt: Date.now() + ttl, ids });
    }
  }

  /**
   * Extract request from GraphQL or HTTP context
   */
  private getRequest(context: ExecutionContext): any {
    if (context.getType<GqlContextType>() === 'graphql') {
      const ctx = GqlExecutionContext.create(context);
      return ctx.getContext()?.req;
    }
    try {
      return context.switchToHttp().getRequest();
    } catch {
      return null;
    }
  }

  // ===================================================================================================================
  // Cache helpers
  // ===================================================================================================================

  /**
   * Look up a membership with process-level TTL cache.
   * Avoids repeated DB queries when the same user accesses the same tenant repeatedly.
   */
  private async findMembershipCached(userId: string, tenantId: string): Promise<CoreTenantMemberModel | null> {
    const ttl = this.cacheTtlMs;

    // Cache disabled (ttl = 0): always query DB
    if (ttl <= 0) {
      return this.memberModel
        .findOne({ status: TenantMemberStatus.ACTIVE, tenant: tenantId, user: userId })
        .lean()
        .exec() as Promise<CoreTenantMemberModel | null>;
    }

    const key = `${userId}:${tenantId}`;
    const now = Date.now();

    const cached = this.membershipCache.get(key);
    if (cached && now < cached.expiresAt) {
      return cached.result;
    }

    const result = (await this.memberModel
      .findOne({
        status: TenantMemberStatus.ACTIVE,
        tenant: tenantId,
        user: userId,
      })
      .lean()
      .exec()) as CoreTenantMemberModel | null;

    // Only cache positive results (active membership found).
    // Negative results (null) are NOT cached to ensure that:
    // - Newly added members are recognized immediately
    // - Removed memberships lead to immediate denial
    if (result) {
      this.evictIfOverCapacity(this.membershipCache);
      this.membershipCache.set(key, { expiresAt: now + ttl, result });
    } else {
      // Ensure stale positive cache entries are removed
      this.membershipCache.delete(key);
    }
    return result;
  }

  /**
   * Evict the oldest entry if the cache exceeds MAX_CACHE_SIZE.
   * Uses a simple FIFO strategy (Map insertion order).
   */
  private evictIfOverCapacity<T>(cache: Map<string, T>): void {
    if (cache.size >= CoreTenantGuard.MAX_CACHE_SIZE) {
      // Delete first 10% to avoid evicting on every insert
      const deleteCount = Math.max(1, Math.floor(CoreTenantGuard.MAX_CACHE_SIZE * 0.1));
      let deleted = 0;
      for (const key of cache.keys()) {
        if (deleted >= deleteCount) break;
        cache.delete(key);
        deleted++;
      }
    }
  }

  /**
   * Remove all expired entries from both caches.
   * Called periodically by the cleanup interval.
   */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.membershipCache.entries()) {
      if (now >= entry.expiresAt) {
        this.membershipCache.delete(key);
      }
    }
    for (const [key, entry] of this.tenantIdsCache.entries()) {
      if (now >= entry.expiresAt) {
        this.tenantIdsCache.delete(key);
      }
    }
  }

  /**
   * Validate tenant membership for a request that was granted access via a system role
   * (S_USER or S_VERIFIED). When a tenant header is present, the user must be an active member
   * of that tenant — unless the user is an admin with adminBypass enabled.
   *
   * On success, sets request.tenantId and request.tenantRole for downstream consumers.
   *
   * @param user - The authenticated request user
   * @param headerTenantId - The validated, non-empty tenant ID from the request header
   * @param request - The HTTP/GraphQL request object
   * @param isAdmin - Whether the user has admin bypass privileges
   */
  private async handleSystemRoleWithTenantHeader(
    user: any,
    headerTenantId: string,
    request: any,
    isAdmin: boolean,
  ): Promise<true> {
    // Admin bypass: same behavior as the HEADER PRESENT admin path below
    if (isAdmin) {
      request.tenantId = headerTenantId;
      request.isAdminBypass = true;
      const safeTenantId = headerTenantId.replace(/[\r\n\t]/g, '_');
      this.logger.debug(`Admin bypass (system-role path): user ${user.id} accessing tenant ${safeTenantId}`);
      return true;
    }

    const membership = await this.findMembershipCached(user.id, headerTenantId);
    if (!membership) {
      throw new ForbiddenException('Not a member of this tenant');
    }
    request.tenantId = headerTenantId;
    request.tenantRole = membership.role as string;
    return true;
  }

  /**
   * Skip tenant validation but still check non-system roles against user.roles.
   * Shared by @SkipTenantCheck decorator path and BetterAuth auto-skip path.
   */
  private skipWithUserRoleCheck(checkableRoles: string[], user: any, isAdmin: boolean): true {
    if (checkableRoles.length > 0) {
      // Defense-in-depth: reject unauthenticated access even if RolesGuard is absent
      if (!user) {
        throw new ForbiddenException('Authentication required');
      }
      if (!isAdmin && !checkRoleAccess(checkableRoles, user.roles, undefined)) {
        throw new ForbiddenException('Insufficient role');
      }
    }
    return true;
  }

  /**
   * Check if the current request is handled by a BetterAuth (IAM) handler
   * (controller or resolver). Used for auto-skip tenant check on IAM endpoints.
   *
   * Uses require() instead of import to avoid a circular dependency:
   * tenant module → better-auth module (which may depend on tenant module indirectly).
   * The require() is lazy and resolved only when needed (Node.js caches the result).
   */
  private isBetterAuthHandler(context: ExecutionContext): boolean {
    const handler = context.getClass();
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { CoreBetterAuthController } =
        require('../better-auth/core-better-auth.controller') as typeof import('../better-auth/core-better-auth.controller');
      if (handler === CoreBetterAuthController || handler.prototype instanceof CoreBetterAuthController) {
        return true;
      }
    } catch {
      /* BetterAuth controller not available */
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { CoreBetterAuthResolver } =
        require('../better-auth/core-better-auth.resolver') as typeof import('../better-auth/core-better-auth.resolver');
      if (handler === CoreBetterAuthResolver || handler.prototype instanceof CoreBetterAuthResolver) {
        return true;
      }
    } catch {
      /* BetterAuth resolver not available */
    }
    return false;
  }
}
