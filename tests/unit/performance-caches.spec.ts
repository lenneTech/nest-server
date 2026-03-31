/**
 * Unit Tests: Performance Caches
 *
 * Tests caching logic across:
 * - processDeep options reuse and circular reference detection
 * - RequestContext bypass short-circuit optimization
 * - CoreTenantGuard membership/tenantIds caches
 * - CoreBetterAuthUserMapper user cache
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── 1. processDeep Options Reuse ───

describe('processDeep', () => {
  let processDeep: typeof import('../../src/core/common/helpers/input.helper').processDeep;

  beforeEach(async () => {
    const mod = await import('../../src/core/common/helpers/input.helper');
    processDeep = mod.processDeep;
  });

  it('should honor specialFunctions at nested levels', () => {
    // An object with a nested child that has a special function
    const child = {
      toJSON: () => 'serialized',
      value: 42,
    };
    const data = { nested: child };

    const visited: any[] = [];
    processDeep(data, (d) => {
      visited.push(d);
      return d;
    }, { specialFunctions: ['toJSON'] });

    // The child should be processed as a whole (via func) but its individual
    // properties (value) should NOT be processed separately because toJSON is a special function.
    // So 'child' should appear in visited but child.value (42) should NOT.
    const hasChild = visited.some((v) => v === child);
    const hasValue42 = visited.some((v) => v === 42);
    expect(hasChild).toBe(true);
    expect(hasValue42).toBe(false);
  });

  it('should honor specialProperties at nested levels', () => {
    const child = {
      _isSpecial: true,
      deep: { a: 1 },
    };
    const data = { wrapper: child };

    const visited: any[] = [];
    processDeep(data, (d) => {
      visited.push(d);
      return d;
    }, { specialProperties: ['_isSpecial'] });

    // child should be passed to func directly, its properties should NOT be recursed into
    const hasChild = visited.some((v) => v === child);
    const hasDeepA = visited.some((v) => v === 1);
    expect(hasChild).toBe(true);
    expect(hasDeepA).toBe(false);
  });

  it('should detect circular references across nested calls (shared WeakMap)', () => {
    const a: any = { name: 'a' };
    const b: any = { name: 'b', ref: a };
    a.ref = b; // circular

    const visited: string[] = [];
    const result = processDeep(a, (d) => {
      if (d && typeof d === 'object' && d.name) {
        visited.push(d.name);
      }
      return d;
    });

    // Both a and b should be visited, but the circular reference should not cause infinite recursion
    expect(result).toBe(a);
    // a is visited first, then b (nested), then the circular ref back to a is detected and skipped
    expect(visited).toContain('a');
    expect(visited).toContain('b');
  });

  it('should create a fresh WeakMap per top-level call', () => {
    const sharedObj = { id: 1, value: 'shared' };

    let callCount = 0;
    const counter = (d: any) => {
      if (d === sharedObj) callCount++;
      return d;
    };

    // First call
    processDeep({ item: sharedObj }, counter);
    expect(callCount).toBe(1);

    // Second call - should also process sharedObj because new WeakMap is created
    processDeep({ item: sharedObj }, counter);
    expect(callCount).toBe(2);
  });
});

// ─── 2. RequestContext Bypass Short-Circuit ───

describe('RequestContext bypass short-circuit', () => {
  let RequestContext: typeof import('../../src/core/common/services/request-context.service').RequestContext;

  beforeEach(async () => {
    const mod = await import('../../src/core/common/services/request-context.service');
    RequestContext = mod.RequestContext;
  });

  describe('runWithBypassRoleGuard', () => {
    it('should return fn() result directly when already bypassed (no new context)', () => {
      // Run inside a context that already has bypassRoleGuard=true
      const result = RequestContext.run({ bypassRoleGuard: true }, () => {
        // This inner call should short-circuit
        return RequestContext.runWithBypassRoleGuard(() => {
          // Verify we are still bypassed
          expect(RequestContext.isBypassRoleGuard()).toBe(true);
          return 'inner-result';
        });
      });

      expect(result).toBe('inner-result');
    });

    it('should return async fn() result when already bypassed', async () => {
      const result = await RequestContext.run({ bypassRoleGuard: true }, () => {
        return RequestContext.runWithBypassRoleGuard(async () => {
          return 'async-result';
        });
      });

      expect(result).toBe('async-result');
    });

    it('should create a new context on the first call (normal path)', () => {
      // Run without any pre-existing bypass
      const result = RequestContext.run({}, () => {
        expect(RequestContext.isBypassRoleGuard()).toBe(false);

        return RequestContext.runWithBypassRoleGuard(() => {
          expect(RequestContext.isBypassRoleGuard()).toBe(true);
          return 'first-call-result';
        });
      });

      expect(result).toBe('first-call-result');
    });

    it('should preserve existing context properties when creating bypass context', () => {
      const result = RequestContext.run(
        { currentUser: { id: 'user-1', roles: ['admin'] }, language: 'de' },
        () => {
          return RequestContext.runWithBypassRoleGuard(() => {
            const ctx = RequestContext.get();
            expect(ctx?.bypassRoleGuard).toBe(true);
            expect(ctx?.currentUser?.id).toBe('user-1');
            expect(ctx?.language).toBe('de');
            return 'preserved';
          });
        },
      );

      expect(result).toBe('preserved');
    });
  });

  describe('runWithBypassTenantGuard', () => {
    it('should return fn() result directly when already bypassed (no new context)', () => {
      const result = RequestContext.run({ bypassTenantGuard: true }, () => {
        return RequestContext.runWithBypassTenantGuard(() => {
          expect(RequestContext.isBypassTenantGuard()).toBe(true);
          return 'tenant-inner';
        });
      });

      expect(result).toBe('tenant-inner');
    });

    it('should create a new context on the first call', () => {
      const result = RequestContext.run({}, () => {
        expect(RequestContext.isBypassTenantGuard()).toBe(false);

        return RequestContext.runWithBypassTenantGuard(() => {
          expect(RequestContext.isBypassTenantGuard()).toBe(true);
          return 'tenant-first-call';
        });
      });

      expect(result).toBe('tenant-first-call');
    });

    it('should preserve existing context when creating bypass context', () => {
      const result = RequestContext.run(
        { tenantId: 'tenant-abc', currentUser: { id: 'u1' } },
        () => {
          return RequestContext.runWithBypassTenantGuard(() => {
            const ctx = RequestContext.get();
            expect(ctx?.bypassTenantGuard).toBe(true);
            expect(ctx?.tenantId).toBe('tenant-abc');
            expect(ctx?.currentUser?.id).toBe('u1');
            return 'ok';
          });
        },
      );

      expect(result).toBe('ok');
    });
  });
});

// ─── 3. CoreTenantGuard Cache ───

describe('CoreTenantGuard cache', () => {
  // We instantiate the guard manually with a mock memberModel.
  // The guard expects @InjectModel for TENANT_MEMBER_MODEL_TOKEN,
  // but for unit tests we pass a mock Mongoose model directly.

  let CoreTenantGuard: typeof import('../../src/core/modules/tenant/core-tenant.guard').CoreTenantGuard;
  let guard: InstanceType<typeof CoreTenantGuard>;
  let mockMemberModel: any;

  beforeEach(async () => {
    const mod = await import('../../src/core/modules/tenant/core-tenant.guard');
    CoreTenantGuard = mod.CoreTenantGuard;

    // Create a mock Mongoose model with findOne and find
    mockMemberModel = {
      find: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      }),
      findOne: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(null),
      }),
    };

    // Instantiate guard with a mock Reflector and mock model
    const mockReflector = {} as any;
    guard = new CoreTenantGuard(mockReflector, mockMemberModel);

    // Set cacheTtlMs > 0 for testing cache behavior
    (guard as any).cacheTtlMs = 5000;

    // Clean up the interval the constructor sets up
    if ((guard as any).cleanupInterval) {
      clearInterval((guard as any).cleanupInterval);
      (guard as any).cleanupInterval = null;
    }
  });

  describe('findMembershipCached', () => {
    it('should return cached result on cache hit without DB query', async () => {
      const membership = { user: 'user1', tenant: 'tenant1', role: 'member', status: 'active' };

      // Pre-populate cache
      const cache: Map<string, any> = (guard as any).membershipCache;
      cache.set('user1:tenant1', {
        expiresAt: Date.now() + 10_000,
        result: membership,
      });

      // Call the private method directly
      const result = await (guard as any).findMembershipCached('user1', 'tenant1');

      expect(result).toBe(membership);
      // The mock model's findOne should NOT have been called
      expect(mockMemberModel.findOne).not.toHaveBeenCalled();
    });

    it('should query DB on cache miss and cache the positive result', async () => {
      const membership = { user: 'user1', tenant: 'tenant1', role: 'owner', status: 'active' };

      // Mock findOne to return a membership
      mockMemberModel.findOne.mockReturnValue({
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(membership),
      });

      const result = await (guard as any).findMembershipCached('user1', 'tenant1');

      expect(result).toBe(membership);
      expect(mockMemberModel.findOne).toHaveBeenCalledTimes(1);

      // Verify it was cached
      const cache: Map<string, any> = (guard as any).membershipCache;
      const cached = cache.get('user1:tenant1');
      expect(cached).toBeDefined();
      expect(cached.result).toBe(membership);
    });

    it('should NOT cache null results (next call hits DB again)', async () => {
      // findOne returns null (no membership)
      mockMemberModel.findOne.mockReturnValue({
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(null),
      });

      const result1 = await (guard as any).findMembershipCached('user1', 'tenant1');
      expect(result1).toBeNull();
      expect(mockMemberModel.findOne).toHaveBeenCalledTimes(1);

      // Second call should also hit DB (null was not cached)
      const result2 = await (guard as any).findMembershipCached('user1', 'tenant1');
      expect(result2).toBeNull();
      expect(mockMemberModel.findOne).toHaveBeenCalledTimes(2);
    });

    it('should query DB when cached entry is expired', async () => {
      const membership = { user: 'user1', tenant: 'tenant1', role: 'member', status: 'active' };

      // Pre-populate cache with expired entry
      const cache: Map<string, any> = (guard as any).membershipCache;
      cache.set('user1:tenant1', {
        expiresAt: Date.now() - 1, // expired
        result: membership,
      });

      const newMembership = { user: 'user1', tenant: 'tenant1', role: 'owner', status: 'active' };
      mockMemberModel.findOne.mockReturnValue({
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(newMembership),
      });

      const result = await (guard as any).findMembershipCached('user1', 'tenant1');

      expect(result).toBe(newMembership);
      expect(mockMemberModel.findOne).toHaveBeenCalledTimes(1);
    });
  });

  describe('evictIfOverCapacity', () => {
    it('should evict entries when cache exceeds MAX_CACHE_SIZE', () => {
      const cache = new Map<string, any>();

      // Fill cache to MAX_CACHE_SIZE
      const maxSize = (CoreTenantGuard as any).MAX_CACHE_SIZE; // 500
      for (let i = 0; i < maxSize; i++) {
        cache.set(`key-${i}`, { expiresAt: Date.now() + 10_000, result: null });
      }
      expect(cache.size).toBe(maxSize);

      // Calling evictIfOverCapacity should remove ~10% (50 entries)
      (guard as any).evictIfOverCapacity(cache);

      const expectedRemoved = Math.max(1, Math.floor(maxSize * 0.1));
      expect(cache.size).toBe(maxSize - expectedRemoved);

      // The first entries should have been evicted (FIFO)
      expect(cache.has('key-0')).toBe(false);
      expect(cache.has('key-49')).toBe(false);
      // Later entries should still exist
      expect(cache.has(`key-${maxSize - 1}`)).toBe(true);
    });

    it('should not evict when cache is below MAX_CACHE_SIZE', () => {
      const cache = new Map<string, any>();
      cache.set('key-1', { expiresAt: Date.now() + 10_000, result: null });
      cache.set('key-2', { expiresAt: Date.now() + 10_000, result: null });

      (guard as any).evictIfOverCapacity(cache);

      expect(cache.size).toBe(2);
    });
  });

  describe('invalidateUser', () => {
    it('should remove all entries for a specific user from both caches', () => {
      const membershipCache: Map<string, any> = (guard as any).membershipCache;
      const tenantIdsCache: Map<string, any> = (guard as any).tenantIdsCache;

      // Populate membership cache with entries for two users
      membershipCache.set('user1:tenantA', { expiresAt: Date.now() + 10_000, result: {} });
      membershipCache.set('user1:tenantB', { expiresAt: Date.now() + 10_000, result: {} });
      membershipCache.set('user2:tenantA', { expiresAt: Date.now() + 10_000, result: {} });

      // Populate tenantIds cache
      tenantIdsCache.set('user1', { expiresAt: Date.now() + 10_000, ids: ['tenantA', 'tenantB'] });
      tenantIdsCache.set('user1:2', { expiresAt: Date.now() + 10_000, ids: ['tenantA'] });
      tenantIdsCache.set('user2', { expiresAt: Date.now() + 10_000, ids: ['tenantA'] });

      guard.invalidateUser('user1');

      // user1 entries should be gone from both caches
      expect(membershipCache.has('user1:tenantA')).toBe(false);
      expect(membershipCache.has('user1:tenantB')).toBe(false);
      expect(tenantIdsCache.has('user1')).toBe(false);
      expect(tenantIdsCache.has('user1:2')).toBe(false);

      // user2 entries should remain
      expect(membershipCache.has('user2:tenantA')).toBe(true);
      expect(tenantIdsCache.has('user2')).toBe(true);
    });
  });

  describe('invalidateAll', () => {
    it('should clear both caches completely', () => {
      const membershipCache: Map<string, any> = (guard as any).membershipCache;
      const tenantIdsCache: Map<string, any> = (guard as any).tenantIdsCache;

      membershipCache.set('user1:tenantA', { expiresAt: Date.now() + 10_000, result: {} });
      membershipCache.set('user2:tenantB', { expiresAt: Date.now() + 10_000, result: {} });
      tenantIdsCache.set('user1', { expiresAt: Date.now() + 10_000, ids: ['tenantA'] });

      guard.invalidateAll();

      expect(membershipCache.size).toBe(0);
      expect(tenantIdsCache.size).toBe(0);
    });
  });

  describe('evictExpired', () => {
    it('should remove expired entries from both caches', () => {
      const membershipCache: Map<string, any> = (guard as any).membershipCache;
      const tenantIdsCache: Map<string, any> = (guard as any).tenantIdsCache;

      // Add some expired and some valid entries
      membershipCache.set('expired1', { expiresAt: Date.now() - 1000, result: {} });
      membershipCache.set('valid1', { expiresAt: Date.now() + 10_000, result: {} });
      tenantIdsCache.set('expired2', { expiresAt: Date.now() - 500, ids: [] });
      tenantIdsCache.set('valid2', { expiresAt: Date.now() + 10_000, ids: [] });

      (guard as any).evictExpired();

      expect(membershipCache.has('expired1')).toBe(false);
      expect(membershipCache.has('valid1')).toBe(true);
      expect(tenantIdsCache.has('expired2')).toBe(false);
      expect(tenantIdsCache.has('valid2')).toBe(true);
    });
  });
});

// ─── 4. CoreBetterAuthUserMapper User Cache ───

describe('CoreBetterAuthUserMapper user cache', () => {
  let CoreBetterAuthUserMapper: typeof import('../../src/core/modules/better-auth/core-better-auth-user.mapper').CoreBetterAuthUserMapper;
  let mapper: InstanceType<typeof CoreBetterAuthUserMapper>;

  beforeEach(async () => {
    const mod = await import('../../src/core/modules/better-auth/core-better-auth-user.mapper');
    CoreBetterAuthUserMapper = mod.CoreBetterAuthUserMapper;

    // Instantiate without DB connection (passing undefined)
    mapper = new CoreBetterAuthUserMapper(undefined as any);
  });

  describe('cacheUserData', () => {
    it('should store minimal data (id, roles, verified) with TTL', () => {
      // Call the private cacheUserData method
      (mapper as any).cacheUserData('iam-1', {
        id: 'db-user-1',
        roles: ['admin'],
        verified: true,
      });

      const cache: Map<string, any> = (mapper as any).userCache;
      const entry = cache.get('iam-1');

      expect(entry).toBeDefined();
      expect(entry.id).toBe('db-user-1');
      expect(entry.roles).toEqual(['admin']);
      expect(entry.verified).toBe(true);
      expect(entry.expiresAt).toBeGreaterThan(0);
    });

    it('should store empty roles array correctly', () => {
      (mapper as any).cacheUserData('iam-2', {
        id: 'db-user-2',
        roles: [],
        verified: false,
      });

      const cache: Map<string, any> = (mapper as any).userCache;
      const entry = cache.get('iam-2');

      expect(entry.roles).toEqual([]);
      expect(entry.verified).toBe(false);
    });
  });

  describe('cache eviction', () => {
    it('should evict oldest entry when exceeding USER_CACHE_MAX', () => {
      const cache: Map<string, any> = (mapper as any).userCache;
      const maxSize = (CoreBetterAuthUserMapper as any).USER_CACHE_MAX; // 500

      // Fill cache to capacity
      for (let i = 0; i < maxSize; i++) {
        cache.set(`iam-${i}`, {
          expiresAt: Date.now() + 10_000,
          id: `id-${i}`,
          roles: [],
          verified: false,
        });
      }
      expect(cache.size).toBe(maxSize);

      // Add one more via cacheUserData, which should evict the first entry
      (mapper as any).cacheUserData('iam-new', {
        id: 'id-new',
        roles: [],
        verified: false,
      });

      expect(cache.size).toBe(maxSize); // Should remain at max (evicted one, added one)
      expect(cache.has('iam-0')).toBe(false); // First entry evicted (FIFO)
      expect(cache.has('iam-new')).toBe(true); // New entry present
    });

    it('should not evict when below capacity', () => {
      const cache: Map<string, any> = (mapper as any).userCache;

      (mapper as any).cacheUserData('iam-1', { id: 'id-1', roles: [], verified: false });
      (mapper as any).cacheUserData('iam-2', { id: 'id-2', roles: [], verified: true });

      expect(cache.size).toBe(2);
      expect(cache.has('iam-1')).toBe(true);
      expect(cache.has('iam-2')).toBe(true);
    });
  });

  describe('invalidateUserCache', () => {
    it('should remove the entry for a specific iamId', () => {
      const cache: Map<string, any> = (mapper as any).userCache;

      (mapper as any).cacheUserData('iam-1', { id: 'id-1', roles: ['admin'], verified: true });
      (mapper as any).cacheUserData('iam-2', { id: 'id-2', roles: [], verified: false });

      expect(cache.size).toBe(2);

      mapper.invalidateUserCache('iam-1');

      expect(cache.has('iam-1')).toBe(false);
      expect(cache.has('iam-2')).toBe(true);
      expect(cache.size).toBe(1);
    });

    it('should be a no-op when iamId does not exist in cache', () => {
      const cache: Map<string, any> = (mapper as any).userCache;

      (mapper as any).cacheUserData('iam-1', { id: 'id-1', roles: [], verified: false });

      mapper.invalidateUserCache('iam-nonexistent');

      expect(cache.size).toBe(1);
      expect(cache.has('iam-1')).toBe(true);
    });
  });
});
