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
 * - Hierarchy roles (in roleHierarchy config): level comparison — higher includes lower
 * - Normal roles (not in roleHierarchy): exact match — no compensation by higher role
 * - Tenant context (header present): checks against membership.role only (user.roles ignored)
 * - No tenant context: checks against user.roles
 *
 * Flow:
 * 1. Config check: multiTenancy enabled?
 * 2. Parse header (X-Tenant-Id, max 128 chars, trimmed)
 * 3. @SkipTenantCheck → role check against user.roles, no tenant context
 * 4. Read @Roles() metadata, filter out system roles
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

    // Read @Roles() metadata and filter to non-system roles
    const rolesMetadata = this.reflector.getAll<string[][]>('roles', [context.getHandler(), context.getClass()]);
    const roles = mergeRolesMetadata(rolesMetadata);

    const user = request.user;
    const adminBypass = config.adminBypass !== false;
    const isAdmin = adminBypass && user?.roles?.includes(RoleEnum.ADMIN);

    // Filter to checkable (non-system) roles only when needed (avoids array allocation on fast paths)
    const hasNonSystemRoles = roles.some((r) => !isSystemRole(r));
    const checkableRoles = hasNonSystemRoles ? roles.filter((r) => !isSystemRole(r)) : [];
    const minRequiredLevel = checkableRoles.length > 0 ? getMinRequiredLevel(checkableRoles) : undefined;

    // @SkipTenantCheck → no tenant context, but role check against user.roles
    const skipTenantCheck = this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_CHECK_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipTenantCheck) {
      if (checkableRoles.length > 0 && user) {
        if (!isAdmin && !checkRoleAccess(checkableRoles, user.roles, undefined)) {
          throw new ForbiddenException('Insufficient role');
        }
      }
      return true;
    }

    // === HEADER PRESENT ===
    if (headerTenantId) {
      // Admin bypass: set req.tenantId so plugin filters (read by RequestContextMiddleware
      // lazy getter → context.tenantId, also consumed by @CurrentTenant() via RequestContext)
      if (isAdmin) {
        request.tenantId = headerTenantId;
        request.isAdminBypass = true;
        const requiredRole = checkableRoles.length > 0 ? checkableRoles.join(',') : 'none';
        this.logger.log(`Admin bypass: user ${user.id} accessing tenant ${headerTenantId} (required: ${requiredRole})`);
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
}
