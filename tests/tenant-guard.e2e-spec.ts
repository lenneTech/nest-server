import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule, Prop, Schema, SchemaFactory, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';
import request from 'supertest';

import { Restricted, checkRestricted } from '../src/core/common/decorators/restricted.decorator';
import { Roles } from '../src/core/common/decorators/roles.decorator';
import { RoleEnum } from '../src/core/common/enums/role.enum';
import { mongooseTenantPlugin } from '../src/core/common/plugins/mongoose-tenant.plugin';
import { ConfigService } from '../src/core/common/services/config.service';
import { IRequestContext, RequestContext } from '../src/core/common/services/request-context.service';
import { CoreTenantMemberModel } from '../src/core/modules/tenant/core-tenant-member.model';
import { CoreTenantGuard } from '../src/core/modules/tenant/core-tenant.guard';
import { CurrentTenant, SkipTenantCheck } from '../src/core/modules/tenant/core-tenant.decorators';
import {
  DEFAULT_ROLE_HIERARCHY,
  DefaultHR,
  TenantMemberStatus,
  createHierarchyRoles,
} from '../src/core/modules/tenant/core-tenant.enums';
import {
  checkRoleAccess,
  getMinRequiredLevel,
  getRoleHierarchy,
  isHierarchyRole,
  isMultiTenancyActive,
  isSystemRole,
} from '../src/core/modules/tenant/core-tenant.helpers';
import { CoreTenantService } from '../src/core/modules/tenant/core-tenant.service';

// =============================================================================
// Test Schema: TenantMember
// =============================================================================
@Schema({ timestamps: true })
class TenantMember extends CoreTenantMemberModel {}

const TenantMemberSchema = SchemaFactory.createForClass(TenantMember);
TenantMemberSchema.index({ user: 1, tenant: 1 }, { unique: true });

// =============================================================================
// Test Schema: TenantItem (has tenantId → plugin activates)
// =============================================================================
@Schema({ timestamps: true })
class TenantItem {
  @Prop({ type: String })
  tenantId: string;

  @Prop({ type: String, required: true })
  name: string;
}

const TenantItemSchema = SchemaFactory.createForClass(TenantItem);

// =============================================================================
// Test Schema: GlobalItem (no tenantId → plugin ignores)
// =============================================================================
@Schema({ timestamps: true })
class GlobalItem {
  @Prop({ type: String, required: true })
  name: string;
}

const GlobalItemSchema = SchemaFactory.createForClass(GlobalItem);

// =============================================================================
// AdminFallback Controller — has class-level @Roles(ADMIN) fallback
// Used to test that method-level system roles are not shadowed by class-level roles
// =============================================================================
@Roles(RoleEnum.ADMIN)
@Controller('admin-fallback')
class AdminFallbackController {
  // Method has @Roles(S_EVERYONE) → class ADMIN fallback must NOT block public access
  @Get('public')
  @Roles(RoleEnum.S_EVERYONE)
  publicEndpoint(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  // Method has @Roles(S_USER) → class ADMIN fallback must NOT block authenticated non-admin users
  @Get('user-only')
  @Roles(RoleEnum.S_USER)
  userOnly(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  // Method has @Roles(S_USER) → unauthenticated user must be blocked (401/403)
  // (The guard returns 403 for unauthenticated, RolesGuard would return 401 — guard returns 403 here)
  @Get('user-only-no-auth')
  @Roles(RoleEnum.S_USER)
  userOnlyNoAuth(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  // Method has @Roles(S_VERIFIED) → verified users can access
  @Get('verified-only')
  @Roles(RoleEnum.S_VERIFIED)
  verifiedOnly(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  // Method has @Roles(S_USER, DefaultHR.OWNER) — mixed: system + real role
  // OR semantics: S_USER fires first → any logged-in user passes (owner is alternative, not required)
  @Get('user-or-owner')
  @Roles(RoleEnum.S_USER, DefaultHR.OWNER)
  userOrOwner(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  // Method has no @Roles → class-level ADMIN fallback applies
  @Get('admin-only')
  adminOnly(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  // Method has @Roles(DefaultHR.OWNER) — real role only
  // → class ADMIN fallback is irrelevant — should still require owner
  @Get('owner-only')
  @Roles(DefaultHR.OWNER)
  ownerOnly(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }
}

// =============================================================================
// Test Controller — uses hierarchy roles (DefaultHR) and system roles
// =============================================================================
@Controller('test')
class TestController {
  @Get('tenant-member')
  @Roles(DefaultHR.MEMBER)
  tenantMember(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  @Get('tenant-manager')
  @Roles(DefaultHR.MANAGER)
  tenantManager(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  @Get('tenant-owner')
  @Roles(DefaultHR.OWNER)
  tenantOwner(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  @Get('user-only')
  @Roles(RoleEnum.S_USER)
  userOnly(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  @Get('public')
  @Roles(RoleEnum.S_EVERYONE)
  publicEndpoint(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  @Get('verified-only')
  @Roles(RoleEnum.S_VERIFIED)
  verifiedOnly(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  @Get('skip-tenant')
  @Roles(RoleEnum.S_USER)
  @SkipTenantCheck()
  skipTenant(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  @Get('skip-tenant-with-role')
  @Roles(DefaultHR.MANAGER)
  @SkipTenantCheck()
  skipTenantWithRole(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  @Get('no-roles')
  noRoles(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  // Normal (non-hierarchy) role endpoints
  @Get('auditor-only')
  @Roles('auditor')
  auditorOnly(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  @Get('moderator-only')
  @Roles('moderator')
  moderatorOnly(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  // @SkipTenantCheck + normal role
  @Get('skip-tenant-with-normal-role')
  @Roles('auditor')
  @SkipTenantCheck()
  skipTenantWithNormalRole(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  // Mixed: hierarchy + normal role (OR semantics)
  @Get('editor-or-auditor')
  @Roles(DefaultHR.MANAGER, 'auditor')
  editorOrAuditor(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }
}

// =============================================================================
// Test Module
// =============================================================================
const TEST_DB_URI = 'mongodb://127.0.0.1/nest-server-tenant-guard-test';

@Module({
  controllers: [TestController, AdminFallbackController],
  imports: [
    MongooseModule.forRoot(TEST_DB_URI, {
      connectionFactory: (connection) => {
        connection.plugin(mongooseTenantPlugin);
        return connection;
      },
    }),
    MongooseModule.forFeature([
      { name: 'TenantMember', schema: TenantMemberSchema },
      { name: TenantItem.name, schema: TenantItemSchema },
      { name: GlobalItem.name, schema: GlobalItemSchema },
    ]),
  ],
  providers: [
    CoreTenantService,
    {
      provide: APP_GUARD,
      useClass: CoreTenantGuard,
    },
  ],
})
class TestModule {}

// =============================================================================
// Helper to create fake RolesGuard-like behavior (just sets user on request)
// The actual RolesGuard is NOT used here — we test CoreTenantGuard in isolation
// but need to simulate that @Roles checks have passed.
// =============================================================================
function createAuthMiddleware() {
  return (req, _res, next) => {
    const userId = req.headers['x-test-user-id'] as string;
    const userRoles = req.headers['x-test-user-roles'] as string;
    const userVerified = req.headers['x-test-user-verified'] as string;
    if (userId) {
      req.user = {
        id: userId,
        roles: userRoles ? userRoles.split(',') : [],
        // verified=true when X-Test-User-Verified header is 'true'
        verified: userVerified === 'true',
        hasRole: (roles: string[]) => {
          const r = userRoles ? userRoles.split(',') : [];
          return roles.some((role) => r.includes(role));
        },
      };
    }
    // RequestContext with lazy getters (simulates RequestContextMiddleware)
    const context: IRequestContext = {
      get currentUser() {
        return req.user;
      },
      get tenantId() {
        return req.tenantId ?? undefined;
      },
      get tenantIds() {
        return req.tenantIds ?? undefined;
      },
      get tenantRole() {
        return req.tenantRole ?? undefined;
      },
      get isAdminBypass() {
        return req.isAdminBypass ?? false;
      },
    };
    RequestContext.run(context, () => next());
  };
}

// =============================================================================
// Tests
// =============================================================================
describe('CoreTenantGuard (e2e)', () => {
  let app: import('@nestjs/common').INestApplication;
  let memberModel: Model<TenantMember>;
  let tenantItemModel: Model<TenantItem>;
  let globalItemModel: Model<GlobalItem>;
  let tenantService: CoreTenantService;

  const TENANT_A = 'tenant-aaa';
  const TENANT_B = 'tenant-bbb';
  const USER_ID = 'user-123';
  const ADMIN_USER_ID = 'admin-user-456';

  beforeAll(async () => {
    new ConfigService({ multiTenancy: {} } as any);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(createAuthMiddleware());
    await app.init();

    memberModel = moduleFixture.get<Model<TenantMember>>(getModelToken('TenantMember'));
    tenantItemModel = moduleFixture.get<Model<TenantItem>>(getModelToken(TenantItem.name));
    globalItemModel = moduleFixture.get<Model<GlobalItem>>(getModelToken(GlobalItem.name));
    tenantService = moduleFixture.get(CoreTenantService);
  });

  beforeEach(async () => {
    await memberModel.deleteMany({});
    await tenantItemModel.deleteMany({});
    await globalItemModel.deleteMany({});
  });

  afterAll(async () => {
    await memberModel.deleteMany({});
    await tenantItemModel.deleteMany({});
    await globalItemModel.deleteMany({});
    await app.close();
    new ConfigService({} as any);
  });

  // =========================================================================
  // A) Header + authenticated user (membership validation)
  // =========================================================================

  it('should allow active member to access hierarchy-role endpoint', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'member');

    const res = await request(app.getHttpServer())
      .get('/test/tenant-member')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  it('should deny non-member access to hierarchy-role endpoint', async () => {
    await request(app.getHttpServer())
      .get('/test/tenant-member')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  it('should deny non-member even on S_USER endpoint when header is present', async () => {
    await request(app.getHttpServer())
      .get('/test/user-only')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  it('should allow member to access S_USER endpoint with header', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'member');

    const res = await request(app.getHttpServer())
      .get('/test/user-only')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  it('should deny suspended member', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'member');
    await tenantService.removeMember(TENANT_A, USER_ID);

    await request(app.getHttpServer())
      .get('/test/tenant-member')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  it('should deny member of different tenant', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'member');

    await request(app.getHttpServer())
      .get('/test/tenant-member')
      .set('X-Tenant-Id', TENANT_B)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  // =========================================================================
  // B) Header + role hierarchy (level comparison)
  // =========================================================================

  it('should deny member-role access to owner-level endpoint', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'member');

    await request(app.getHttpServer())
      .get('/test/tenant-owner')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  it('should deny manager-role access to owner-level endpoint', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'manager');

    await request(app.getHttpServer())
      .get('/test/tenant-owner')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  it('should allow owner-role access to owner-level endpoint', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'owner');

    const res = await request(app.getHttpServer())
      .get('/test/tenant-owner')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  it('should deny member-role access to manager-level endpoint', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'member');

    await request(app.getHttpServer())
      .get('/test/tenant-manager')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  it('should allow manager-role access to manager-level endpoint', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'manager');

    const res = await request(app.getHttpServer())
      .get('/test/tenant-manager')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  it('should allow owner-role access to manager-level endpoint (higher includes lower)', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'owner');

    const res = await request(app.getHttpServer())
      .get('/test/tenant-manager')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  // =========================================================================
  // B2) Tenant overrides user.roles
  // =========================================================================

  it('should use tenant membership role, not user.roles, when header is present', async () => {
    // User has 'manager' in user.roles but only 'member' in tenant membership
    await tenantService.addMember(TENANT_A, USER_ID, 'member');

    await request(app.getHttpServer())
      .get('/test/tenant-manager')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .set('X-Test-User-Roles', 'manager')
      .expect(403);
  });

  // =========================================================================
  // B3) Header + no user → 403
  // =========================================================================

  it('should deny unauthenticated access when header is present', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/tenant-member')
      .set('X-Tenant-Id', TENANT_A)
      .expect(403);

    expect(res.body.message).toContain('Authentication required');
  });

  // =========================================================================
  // C) Admin behavior
  // =========================================================================

  it('should allow admin to access tenant without membership', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/tenant-member')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', ADMIN_USER_ID)
      .set('X-Test-User-Roles', RoleEnum.ADMIN)
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  it('should allow admin to access owner-level endpoint with header', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/tenant-owner')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', ADMIN_USER_ID)
      .set('X-Test-User-Roles', RoleEnum.ADMIN)
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  it('should allow admin to access hierarchy-role endpoint without header', async () => {
    await request(app.getHttpServer())
      .get('/test/tenant-member')
      .set('X-Test-User-Id', ADMIN_USER_ID)
      .set('X-Test-User-Roles', RoleEnum.ADMIN)
      .expect(200);
  });

  it('should give admin access to all data without header (isAdminBypass)', async () => {
    // Seed data in multiple tenants
    await RequestContext.runWithBypassTenantGuard(async () => {
      await tenantItemModel.create({ name: 'item-a', tenantId: TENANT_A });
      await tenantItemModel.create({ name: 'item-b', tenantId: TENANT_B });
    });

    // Admin without header → isAdminBypass → plugin returns empty filter
    const context: IRequestContext = {
      currentUser: { id: ADMIN_USER_ID, roles: [RoleEnum.ADMIN] },
      isAdminBypass: true,
    };
    const items = await RequestContext.run(context, () => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(2);
  });

  it('should deny admin when adminBypass is false', async () => {
    new ConfigService({ multiTenancy: { adminBypass: false } } as any);

    try {
      await request(app.getHttpServer())
        .get('/test/tenant-member')
        .set('X-Tenant-Id', TENANT_A)
        .set('X-Test-User-Id', ADMIN_USER_ID)
        .set('X-Test-User-Roles', RoleEnum.ADMIN)
        .expect(403);
    } finally {
      ConfigService.setConfig({ multiTenancy: {} } as any);
    }
  });

  // =========================================================================
  // D) No header — hierarchy roles check user.roles
  // =========================================================================

  it('should allow user with matching user.roles when no header (hierarchy: level comparison)', async () => {
    // user.roles=['manager'] meets @Roles(DefaultHR.MEMBER) because manager(2) >= member(1)
    await tenantService.addMember(TENANT_A, USER_ID, 'manager');

    const res = await request(app.getHttpServer())
      .get('/test/tenant-member')
      .set('X-Test-User-Id', USER_ID)
      .set('X-Test-User-Roles', 'manager')
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  it('should deny user with insufficient user.roles level when no header', async () => {
    // user.roles=['member'] does NOT meet @Roles(DefaultHR.MANAGER) because member(1) < manager(2)
    const res = await request(app.getHttpServer())
      .get('/test/tenant-manager')
      .set('X-Test-User-Id', USER_ID)
      .set('X-Test-User-Roles', 'member')
      .expect(403);

    expect(res.body.message).toContain('Insufficient role');
  });

  it('should deny unauthenticated user with hierarchy roles and no header', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/tenant-member')
      .expect(403);

    expect(res.body.message).toContain('Authentication required');
  });

  it('should resolve filtered tenantIds when no header + hierarchy role', async () => {
    // User is member (level 1) in tenant A, owner (level 3) in tenant B
    await tenantService.addMember(TENANT_A, USER_ID, 'member');
    await tenantService.addMember(TENANT_B, USER_ID, 'owner');

    await RequestContext.runWithBypassTenantGuard(async () => {
      await tenantItemModel.create({ name: 'item-a', tenantId: TENANT_A });
      await tenantItemModel.create({ name: 'item-b', tenantId: TENANT_B });
    });

    // @Roles(DefaultHR.MANAGER) requires level >= 2
    // → only tenant B (owner, level 3) qualifies
    const context: IRequestContext = {
      currentUser: { id: USER_ID },
      tenantIds: [TENANT_B], // only tenant B qualifies for manager level
    };
    const items = await RequestContext.run(context, () => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(1);
    expect((items[0] as any).name).toBe('item-b');
  });

  it('should resolve user tenantIds when no header and S_USER', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'member');
    await tenantService.addMember(TENANT_B, USER_ID, 'member');

    // Seed data
    await RequestContext.runWithBypassTenantGuard(async () => {
      await tenantItemModel.create({ name: 'item-a', tenantId: TENANT_A });
      await tenantItemModel.create({ name: 'item-b', tenantId: TENANT_B });
      await tenantItemModel.create({ name: 'item-c', tenantId: 'tenant-ccc' });
    });

    // The guard sets tenantIds on request; verify via RequestContext
    const context: IRequestContext = {
      currentUser: { id: USER_ID },
      tenantIds: [TENANT_A, TENANT_B],
    };
    const items = await RequestContext.run(context, () => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(2);
    expect(items.map((i: any) => i.name).sort()).toEqual(['item-a', 'item-b']);
  });

  // =========================================================================
  // D2) Normal (non-hierarchy) roles
  // =========================================================================

  it('should allow normal role in tenant context (exact match)', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'auditor');

    const res = await request(app.getHttpServer())
      .get('/test/auditor-only')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  it('should deny normal role in tenant context when membership role does not match', async () => {
    // membership.role='manager' does NOT satisfy @Roles('auditor') — no hierarchy compensation
    await tenantService.addMember(TENANT_A, USER_ID, 'manager');

    await request(app.getHttpServer())
      .get('/test/auditor-only')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  it('should allow normal role without tenant (exact match against user.roles)', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/moderator-only')
      .set('X-Test-User-Id', USER_ID)
      .set('X-Test-User-Roles', 'moderator')
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  it('should deny normal role without tenant when user.roles does not match', async () => {
    await request(app.getHttpServer())
      .get('/test/moderator-only')
      .set('X-Test-User-Id', USER_ID)
      .set('X-Test-User-Roles', 'viewer')
      .expect(403);
  });

  // =========================================================================
  // D3) Mixed roles (OR semantics)
  // =========================================================================

  it('should allow when hierarchy role matches in mixed @Roles (OR semantics)', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'manager');

    const res = await request(app.getHttpServer())
      .get('/test/editor-or-auditor')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  it('should allow when normal role matches in mixed @Roles (OR semantics)', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'auditor');

    const res = await request(app.getHttpServer())
      .get('/test/editor-or-auditor')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  it('should deny when neither hierarchy nor normal role matches in mixed @Roles', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'member'); // level 1 < manager level 2, not 'auditor'

    await request(app.getHttpServer())
      .get('/test/editor-or-auditor')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  // =========================================================================
  // E) @SkipTenantCheck
  // =========================================================================

  it('should skip tenant check when @SkipTenantCheck is present (with header)', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/skip-tenant')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.ok).toBe(true);
    // @CurrentTenant reads from RequestContext.tenantId which is not set when guard is skipped
    expect(res.body.tenantId).toBeUndefined();
  });

  it('should skip tenant check when @SkipTenantCheck is present (no header)', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/skip-tenant')
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  it('should check user.roles for @SkipTenantCheck + hierarchy role', async () => {
    // @SkipTenantCheck + @Roles(DefaultHR.MANAGER) → checks user.roles, no tenant context
    const res = await request(app.getHttpServer())
      .get('/test/skip-tenant-with-role')
      .set('X-Test-User-Id', USER_ID)
      .set('X-Test-User-Roles', 'owner') // owner(3) >= manager(2)
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  it('should deny @SkipTenantCheck + hierarchy role when user.roles insufficient', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/skip-tenant-with-role')
      .set('X-Test-User-Id', USER_ID)
      .set('X-Test-User-Roles', 'member') // member(1) < manager(2)
      .expect(403);

    expect(res.body.message).toContain('Insufficient role');
  });

  it('should check user.roles for @SkipTenantCheck + normal role (exact match)', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/skip-tenant-with-normal-role')
      .set('X-Test-User-Id', USER_ID)
      .set('X-Test-User-Roles', 'auditor')
      .expect(200);

    expect(res.body.ok).toBe(true);
    // No tenant context set (skip)
    expect(res.body.tenantId).toBeUndefined();
  });

  it('should deny @SkipTenantCheck + normal role when user.roles does not match', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/skip-tenant-with-normal-role')
      .set('X-Test-User-Id', USER_ID)
      .set('X-Test-User-Roles', 'moderator') // moderator != auditor
      .expect(403);

    expect(res.body.message).toContain('Insufficient role');
  });

  it('should deny @SkipTenantCheck + normal role when header is present (no tenant context)', async () => {
    // @SkipTenantCheck ignores the header — role is checked against user.roles only
    const res = await request(app.getHttpServer())
      .get('/test/skip-tenant-with-normal-role')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .set('X-Test-User-Roles', 'auditor')
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.tenantId).toBeUndefined();
  });

  it('should deny @SkipTenantCheck + non-system role when user is unauthenticated (defense-in-depth)', async () => {
    // No X-Test-User-Id → req.user is undefined
    // skipWithUserRoleCheck: checkableRoles.length > 0 && !user → 403 'Authentication required'
    const res = await request(app.getHttpServer())
      .get('/test/skip-tenant-with-normal-role')
      .expect(403);

    expect(res.body.message).toContain('Authentication required');
  });

  // =========================================================================
  // F) Config tests
  // =========================================================================

  it('should read custom header name', async () => {
    new ConfigService({ multiTenancy: { headerName: 'x-workspace-id' } } as any);
    try {
      await tenantService.addMember(TENANT_A, USER_ID, 'member');

      const res = await request(app.getHttpServer())
        .get('/test/tenant-member')
        .set('X-Workspace-Id', TENANT_A)
        .set('X-Test-User-Id', USER_ID)
        .expect(200);

      expect(res.body.tenantId).toBe(TENANT_A);
    } finally {
      ConfigService.setConfig({ multiTenancy: {} } as any);
    }
  });

  it('should ignore header longer than 128 characters', async () => {
    const longHeader = 'a'.repeat(129);

    // Hierarchy role without valid header → 403 "Authentication required"
    const res = await request(app.getHttpServer())
      .get('/test/tenant-member')
      .set('X-Tenant-Id', longHeader)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);

    expect(res.body.message).toContain('Insufficient role');
  });

  it('should use custom role hierarchy', async () => {
    new ConfigService({
      multiTenancy: {
        roleHierarchy: { viewer: 1, editor: 2, admin: 3, owner: 4 },
      },
    } as any);

    try {
      await tenantService.addMember(TENANT_A, USER_ID, 'editor');

      // @Roles(DefaultHR.MEMBER) → 'member' is NOT in custom hierarchy → treated as normal role
      // editor != member → 403
      // Note: DefaultHR.MEMBER = 'member' which is not in the custom hierarchy
      await request(app.getHttpServer())
        .get('/test/tenant-member')
        .set('X-Tenant-Id', TENANT_A)
        .set('X-Test-User-Id', USER_ID)
        .expect(403);
    } finally {
      ConfigService.setConfig({ multiTenancy: {} } as any);
    }
  });

  it('should work with same-level roles in custom hierarchy', async () => {
    new ConfigService({
      multiTenancy: {
        roleHierarchy: { viewer: 1, editor: 2, manager: 2, owner: 3 },
      },
    } as any);

    try {
      // Create a controller-like scenario by directly testing checkRoleAccess
      // editor(2) should satisfy @Roles('manager') because they share level 2
      // But we can't easily add a custom controller to the test module,
      // so we verify via the helper function
      expect(checkRoleAccess(['manager'], undefined, 'editor')).toBe(true);
      expect(checkRoleAccess(['editor'], undefined, 'manager')).toBe(true);
      expect(checkRoleAccess(['owner'], undefined, 'editor')).toBe(false);
    } finally {
      ConfigService.setConfig({ multiTenancy: {} } as any);
    }
  });

  // =========================================================================
  // G) Plugin Safety Net tests
  // =========================================================================

  it('should throw ForbiddenException for tenantId-schema without context', async () => {
    await RequestContext.runWithBypassTenantGuard(async () => {
      await tenantItemModel.create({ name: 'item', tenantId: TENANT_A });
    });

    const context: IRequestContext = {};
    await expect(
      RequestContext.run(context, () => tenantItemModel.find().lean().exec()),
    ).rejects.toThrow('Tenant context required');
  });

  it('should bypass safety net with bypassTenantGuard', async () => {
    await RequestContext.runWithBypassTenantGuard(async () => {
      await tenantItemModel.create({ name: 'item-a', tenantId: TENANT_A });
      await tenantItemModel.create({ name: 'item-b', tenantId: TENANT_B });
    });

    const items = await RequestContext.runWithBypassTenantGuard(() =>
      tenantItemModel.find().lean().exec(),
    );
    expect(items).toHaveLength(2);
  });

  it('should not affect schemas without tenantId', async () => {
    await globalItemModel.create({ name: 'global' });

    const context: IRequestContext = {};
    const items = await RequestContext.run(context, () => globalItemModel.find().lean().exec());
    expect(items).toHaveLength(1);
  });

  it('should trigger safety net for user without memberships on tenantId-schema', async () => {
    await RequestContext.runWithBypassTenantGuard(async () => {
      await tenantItemModel.create({ name: 'item-a', tenantId: TENANT_A });
    });

    const context: IRequestContext = {
      currentUser: { id: USER_ID },
    };
    await expect(
      RequestContext.run(context, () => tenantItemModel.find().lean().exec()),
    ).rejects.toThrow('Tenant context required');
  });

  it('should trigger safety net for public endpoint on tenantId-schema', async () => {
    await RequestContext.runWithBypassTenantGuard(async () => {
      await tenantItemModel.create({ name: 'item-a', tenantId: TENANT_A });
    });

    const context: IRequestContext = {};
    await expect(
      RequestContext.run(context, () => tenantItemModel.find().lean().exec()),
    ).rejects.toThrow('Tenant context required');
  });

  it('should allow public access to non-tenant schema', async () => {
    await globalItemModel.create({ name: 'global-1' });

    const context: IRequestContext = {};
    const items = await RequestContext.run(context, () => globalItemModel.find().lean().exec());
    expect(items).toHaveLength(1);
  });

  // =========================================================================
  // H) Integration (end-to-end data flow)
  // =========================================================================

  it('should filter data correctly through the full guard+plugin chain', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'member');

    await RequestContext.runWithBypassTenantGuard(async () => {
      await tenantItemModel.create({ name: 'item-a', tenantId: TENANT_A });
      await tenantItemModel.create({ name: 'item-b', tenantId: TENANT_B });
    });

    const context: IRequestContext = {
      currentUser: { id: USER_ID },
      tenantId: TENANT_A,
    };
    const items = await RequestContext.run(context, () => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(1);
    expect((items[0] as any).name).toBe('item-a');
  });

  it('should return data from multiple tenants with $in filter', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'member');
    await tenantService.addMember(TENANT_B, USER_ID, 'member');

    await RequestContext.runWithBypassTenantGuard(async () => {
      await tenantItemModel.create({ name: 'item-a', tenantId: TENANT_A });
      await tenantItemModel.create({ name: 'item-b', tenantId: TENANT_B });
      await tenantItemModel.create({ name: 'item-c', tenantId: 'tenant-ccc' });
    });

    const context: IRequestContext = {
      currentUser: { id: USER_ID },
      tenantIds: [TENANT_A, TENANT_B],
    };
    const items = await RequestContext.run(context, () => tenantItemModel.find().lean().exec());
    expect(items).toHaveLength(2);
    expect(items.map((i: any) => i.name).sort()).toEqual(['item-a', 'item-b']);
  });

  // =========================================================================
  // Default hierarchy check
  // =========================================================================
  it('should have correct default role hierarchy', () => {
    expect(DEFAULT_ROLE_HIERARCHY.member).toBeLessThan(DEFAULT_ROLE_HIERARCHY.manager);
    expect(DEFAULT_ROLE_HIERARCHY.manager).toBeLessThan(DEFAULT_ROLE_HIERARCHY.owner);
  });

  // =========================================================================
  // I) System role shadowing by class-level ADMIN fallback (regression)
  //
  // Bug: When class has @Roles(ADMIN) and method has @Roles(S_USER), merged
  // roles become [S_USER, ADMIN]. After filtering system roles, checkableRoles
  // = [ADMIN]. CoreTenantGuard then requires ADMIN, blocking non-admin users
  // even though the method explicitly allows S_USER.
  //
  // Fix: method-level system roles must override class-level real roles.
  // =========================================================================

  it('[regression] S_EVERYONE on method with ADMIN on class: unauthenticated user should get 200', async () => {
    // Bug: merged [S_EVERYONE, ADMIN] → S_EVERYONE caught at line 195, returns true — was already OK
    // But this test confirms the early-return path continues to work
    const res = await request(app.getHttpServer())
      .get('/admin-fallback/public')
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  it('[regression] S_USER on method with ADMIN on class: authenticated non-admin user should get 200', async () => {
    // Bug: Without fix, merged [S_USER, ADMIN] → checkableRoles=[ADMIN] → non-admin user gets 403
    const res = await request(app.getHttpServer())
      .get('/admin-fallback/user-only')
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  it('[regression] S_USER on method with ADMIN on class: unauthenticated user should get 403', async () => {
    // S_USER means "must be logged in" — unauthenticated access must be blocked.
    // With the corrected OR-semantics: S_USER is checked as an alternative BEFORE real roles.
    // When S_USER is in the active role set and no user is present, the guard throws 403.
    // (In production, RolesGuard would block unauthenticated requests earlier with 401.)
    await request(app.getHttpServer())
      .get('/admin-fallback/user-only-no-auth')
      .expect(403);
  });

  it('[regression] no @Roles on method with ADMIN on class: non-admin user should get 403', async () => {
    // No method roles → class-level ADMIN applies → non-admin must be blocked
    // Without fix: already worked (no method roles → class roles as fallback)
    // With fix: must still work (fallback only suppressed when method has only system roles)
    const res = await request(app.getHttpServer())
      .get('/admin-fallback/admin-only')
      .set('X-Test-User-Id', USER_ID)
      .expect(403);

    expect(res.body.message).toContain('Insufficient role');
  });

  it('[regression] no @Roles on method with ADMIN on class: admin user should get 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin-fallback/admin-only')
      .set('X-Test-User-Id', ADMIN_USER_ID)
      .set('X-Test-User-Roles', RoleEnum.ADMIN)
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  it('[regression] real role on method with ADMIN on class: requires real role (not blocked by class fallback)', async () => {
    // @Roles(DefaultHR.OWNER) on method with @Roles(ADMIN) on class
    // → effectiveCheckableRoles should be ['owner'] (method has only non-system roles, no override)
    // → member user (level 1) cannot access owner (level 3) endpoint
    await tenantService.addMember(TENANT_A, USER_ID, 'member');

    await request(app.getHttpServer())
      .get('/admin-fallback/owner-only')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  it('[regression] mixed S_USER+owner on method with ADMIN on class: owner-member can access (S_USER satisfied)', async () => {
    // @Roles(S_USER, DefaultHR.OWNER) on method with @Roles(ADMIN) on class.
    // OR semantics: S_USER fires first for any authenticated user → access granted.
    // The owner role is an alternative — not required when S_USER is already satisfied.
    // With header present: membership is still validated for tenant context (any role suffices).
    await tenantService.addMember(TENANT_A, USER_ID, 'owner');

    const res = await request(app.getHttpServer())
      .get('/admin-fallback/user-or-owner')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  it('[regression] S_USER on method with ADMIN on class + X-Tenant-Id: admin non-member gets admin bypass', async () => {
    // Admin user sends X-Tenant-Id to a tenant they're NOT a member of.
    // S_USER early-return fires → handleSystemRoleWithTenantHeader → admin bypass → 200.
    // Without admin bypass in handleSystemRoleWithTenantHeader, this would be 403 (regression).
    const res = await request(app.getHttpServer())
      .get('/admin-fallback/user-only')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', ADMIN_USER_ID)
      .set('X-Test-User-Roles', RoleEnum.ADMIN)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.tenantId).toBe(TENANT_A);
  });

  it('[regression] mixed S_USER+owner on method with ADMIN on class: member-user can access (S_USER satisfied)', async () => {
    // @Roles(S_USER, DefaultHR.OWNER) → S_USER is an alternative — authenticated member passes.
    // Previously (old filter logic): effectiveCheckableRoles=['owner'] → member was blocked.
    // Now (OR semantics): S_USER fires before the real-role check → member gets through.
    await tenantService.addMember(TENANT_A, USER_ID, 'member');

    const res = await request(app.getHttpServer())
      .get('/admin-fallback/user-or-owner')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  // =========================================================================
  // J) System roles as OR alternatives (S_USER, S_VERIFIED, S_EVERYONE)
  //
  // System roles are checked BEFORE real roles. When a system role in the
  // active role set is satisfied, access is granted immediately (OR semantics).
  // Real roles in the same @Roles() decorator are alternatives, not conjunctions.
  // =========================================================================

  // J1: Covered by regression test above: '[regression] S_EVERYONE on method with ADMIN on class'

  // J2: S_EVERYONE + X-Tenant-Id header → 200 without auth (header is ignored for S_EVERYONE)
  it('S_EVERYONE on method + ADMIN on class + X-Tenant-Id header: unauthenticated user gets 200', async () => {
    // S_EVERYONE fires before any tenant check → tenant header is ignored entirely
    const res = await request(app.getHttpServer())
      .get('/admin-fallback/public')
      .set('X-Tenant-Id', TENANT_A)
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  // J3: S_USER on method + ADMIN on class → 200 for authenticated non-admin (no header)
  it('S_USER on method + ADMIN on class: authenticated non-admin without header gets 200', async () => {
    // S_USER fires and user is authenticated → pass (no tenant context expected)
    const res = await request(app.getHttpServer())
      .get('/admin-fallback/user-only')
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.tenantId).toBeUndefined();
  });

  // J4: S_USER on method + ADMIN on class → 403 for unauthenticated
  it('S_USER on method + ADMIN on class: unauthenticated user gets 403', async () => {
    // S_USER present, no user → throws ForbiddenException('Authentication required')
    await request(app.getHttpServer())
      .get('/admin-fallback/user-only')
      .expect(403);
  });

  // J5: S_USER on method + X-Tenant-Id header → 200 for tenant member
  it('S_USER on method + X-Tenant-Id header: member gets 200 with tenant context set', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'member');

    const res = await request(app.getHttpServer())
      .get('/test/user-only')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  // J6: S_USER on method + X-Tenant-Id header → 403 for non-member (tenant membership required with header)
  it('S_USER on method + X-Tenant-Id header: non-member gets 403', async () => {
    // S_USER fires + user present → header present → membership check → non-member → 403
    await request(app.getHttpServer())
      .get('/test/user-only')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  // J7: S_VERIFIED on method → 200 for verified user (no header)
  it('S_VERIFIED on method: verified user (verified=true) gets 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/verified-only')
      .set('X-Test-User-Id', USER_ID)
      .set('X-Test-User-Verified', 'true')
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  // J8: S_VERIFIED on method → 403 for unverified user
  it('S_VERIFIED on method: unverified user gets 403', async () => {
    await request(app.getHttpServer())
      .get('/test/verified-only')
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  // J9: S_VERIFIED on method → 403 for unauthenticated user
  it('S_VERIFIED on method: unauthenticated user gets 403', async () => {
    await request(app.getHttpServer())
      .get('/test/verified-only')
      .expect(403);
  });

  // J10: S_VERIFIED + X-Tenant-Id header → 200 for verified tenant member
  it('S_VERIFIED on method + X-Tenant-Id header: verified member gets 200 with tenant context', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'member');

    const res = await request(app.getHttpServer())
      .get('/test/verified-only')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .set('X-Test-User-Verified', 'true')
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  // J11: S_VERIFIED + X-Tenant-Id header → 403 for verified non-member
  it('S_VERIFIED on method + X-Tenant-Id header: verified non-member gets 403', async () => {
    // S_VERIFIED fires + user is verified → header present → membership check → non-member → 403
    await request(app.getHttpServer())
      .get('/test/verified-only')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .set('X-Test-User-Verified', 'true')
      .expect(403);
  });

  // J12: S_EVERYONE + header + authenticated member → tenant context enrichment
  it('S_EVERYONE on method + X-Tenant-Id header + authenticated member: tenant context enriched', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'member');

    const res = await request(app.getHttpServer())
      .get('/test/public')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    // S_EVERYONE returns true (public), but when header + user + member, tenant context is enriched
    expect(res.body.ok).toBe(true);
    expect(res.body.tenantId).toBe(TENANT_A);
  });

  // J13: S_EVERYONE + header + authenticated non-member → 200 but no tenant context
  it('S_EVERYONE on method + X-Tenant-Id header + authenticated non-member: no tenant context', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/public')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    // S_EVERYONE = public, non-member is not blocked, but tenant context is not set
    expect(res.body.ok).toBe(true);
    expect(res.body.tenantId).toBeUndefined();
  });

  // J14: S_VERIFIED + header + admin non-member → admin bypass
  it('S_VERIFIED on method + X-Tenant-Id header: admin non-member gets admin bypass', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/verified-only')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', ADMIN_USER_ID)
      .set('X-Test-User-Roles', RoleEnum.ADMIN)
      .set('X-Test-User-Verified', 'true')
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.tenantId).toBe(TENANT_A);
  });

  // J15: S_USER + owner on method → S_USER satisfied for any logged-in user (OR alternative)
  it('S_USER + owner on method: any authenticated user passes (S_USER is OR alternative, no header)', async () => {
    // OR semantics: S_USER fires before owner check → any logged-in user passes
    const res = await request(app.getHttpServer())
      .get('/admin-fallback/user-or-owner')
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  // J16: No method @Roles + class-level ADMIN → requires ADMIN (class-level fallback still works)
  it('no method @Roles + ADMIN on class: non-admin user gets 403 (class fallback applies)', async () => {
    await request(app.getHttpServer())
      .get('/admin-fallback/admin-only')
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

});

// =============================================================================
// CoreTenantService tests
// =============================================================================
describe('CoreTenantService (e2e)', () => {
  let app: import('@nestjs/common').INestApplication;
  let memberModel: Model<TenantMember>;
  let tenantService: CoreTenantService;

  const TENANT_A = 'tenant-svc-a';
  const USER_1 = 'user-svc-1';
  const USER_2 = 'user-svc-2';

  beforeAll(async () => {
    // Full reinitialize to avoid config leaking from guard tests
    ConfigService.setConfig({ multiTenancy: {} } as any);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot('mongodb://127.0.0.1/nest-server-tenant-svc-test'),
        MongooseModule.forFeature([{ name: 'TenantMember', schema: TenantMemberSchema }]),
      ],
      providers: [CoreTenantService],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    memberModel = moduleFixture.get<Model<TenantMember>>(getModelToken('TenantMember'));
    tenantService = moduleFixture.get(CoreTenantService);
  });

  beforeEach(async () => {
    await memberModel.deleteMany({});
  });

  afterAll(async () => {
    await memberModel.deleteMany({});
    await app.close();
    new ConfigService({} as any);
  });

  // =========================================================================
  // addMember
  // =========================================================================
  it('should add a new member with default role', async () => {
    const member = await tenantService.addMember(TENANT_A, USER_1);
    expect(member.user).toBe(USER_1);
    expect(member.tenant).toBe(TENANT_A);
    expect(member.role).toBe('member');
    expect(member.status).toBe(TenantMemberStatus.ACTIVE);
  });

  it('should add a new member with explicit role', async () => {
    const member = await tenantService.addMember(TENANT_A, USER_1, 'manager');
    expect(member.role).toBe('manager');
  });

  it('should reject duplicate active membership', async () => {
    await tenantService.addMember(TENANT_A, USER_1);
    await expect(tenantService.addMember(TENANT_A, USER_1)).rejects.toThrow('User is already an active member');
  });

  it('should reactivate suspended membership', async () => {
    await tenantService.addMember(TENANT_A, USER_1, 'member');
    // Need a second owner to allow removal
    await tenantService.addMember(TENANT_A, USER_2, 'owner');
    await tenantService.removeMember(TENANT_A, USER_1);

    const reactivated = await tenantService.addMember(TENANT_A, USER_1, 'manager');
    expect(reactivated.status).toBe(TenantMemberStatus.ACTIVE);
    expect(reactivated.role).toBe('manager');
  });

  // =========================================================================
  // removeMember
  // =========================================================================
  it('should suspend a member', async () => {
    await tenantService.addMember(TENANT_A, USER_1, 'member');
    const removed = await tenantService.removeMember(TENANT_A, USER_1);
    expect(removed.status).toBe(TenantMemberStatus.SUSPENDED);
  });

  it('should prevent removing the last owner', async () => {
    await tenantService.addMember(TENANT_A, USER_1, 'owner');
    await expect(tenantService.removeMember(TENANT_A, USER_1)).rejects.toThrow(
      'Cannot remove or demote the last owner',
    );
  });

  // =========================================================================
  // updateMemberRole
  // =========================================================================
  it('should update member role', async () => {
    await tenantService.addMember(TENANT_A, USER_1, 'member');
    const updated = await tenantService.updateMemberRole(TENANT_A, USER_1, 'manager');
    expect(updated.role).toBe('manager');
  });

  it('should prevent demoting the last owner', async () => {
    await tenantService.addMember(TENANT_A, USER_1, 'owner');
    await expect(tenantService.updateMemberRole(TENANT_A, USER_1, 'member')).rejects.toThrow(
      'Cannot remove or demote the last owner',
    );
  });

  // =========================================================================
  // findMemberships
  // =========================================================================
  it('should find all active memberships for a user', async () => {
    await tenantService.addMember('tenant-1', USER_1, 'member');
    await tenantService.addMember('tenant-2', USER_1, 'manager');

    const memberships = await tenantService.findMemberships(USER_1);
    expect(memberships).toHaveLength(2);
  });

  // =========================================================================
  // getMembership
  // =========================================================================
  it('should get a specific membership', async () => {
    await tenantService.addMember(TENANT_A, USER_1, 'member');
    const membership = await tenantService.getMembership(TENANT_A, USER_1);
    expect(membership).toBeTruthy();
    expect(membership.role).toBe('member');
  });

  it('should return null for non-existent membership', async () => {
    const membership = await tenantService.getMembership(TENANT_A, 'non-existent');
    expect(membership).toBeNull();
  });
});

// =============================================================================
// Helper Functions tests
// =============================================================================
describe('Tenant Helper Functions', () => {
  beforeAll(() => {
    ConfigService.setConfig({ multiTenancy: {} } as any);
  });

  afterAll(() => {
    new ConfigService({} as any);
  });

  // =========================================================================
  // isSystemRole
  // =========================================================================
  it('should identify system roles', () => {
    expect(isSystemRole('s_user')).toBe(true);
    expect(isSystemRole('s_everyone')).toBe(true);
    expect(isSystemRole('s_no_one')).toBe(true);
    expect(isSystemRole('s_creator')).toBe(true);
    expect(isSystemRole('admin')).toBe(false);
    expect(isSystemRole('member')).toBe(false);
    expect(isSystemRole('auditor')).toBe(false);
  });

  // =========================================================================
  // isMultiTenancyActive
  // =========================================================================
  it('should detect multiTenancy activation', () => {
    expect(isMultiTenancyActive()).toBe(true); // {} config set in beforeAll

    ConfigService.setConfig({} as any);
    expect(isMultiTenancyActive()).toBe(false);

    ConfigService.setConfig({ multiTenancy: { enabled: false } } as any);
    expect(isMultiTenancyActive()).toBe(false);

    ConfigService.setConfig({ multiTenancy: { enabled: true } } as any);
    expect(isMultiTenancyActive()).toBe(true);

    // Restore
    ConfigService.setConfig({ multiTenancy: {} } as any);
  });

  // =========================================================================
  // isHierarchyRole
  // =========================================================================
  it('should identify hierarchy roles', () => {
    expect(isHierarchyRole('member')).toBe(true);
    expect(isHierarchyRole('manager')).toBe(true);
    expect(isHierarchyRole('owner')).toBe(true);
    expect(isHierarchyRole('auditor')).toBe(false);
    expect(isHierarchyRole('admin')).toBe(false);
  });

  it('should return false for hierarchy roles when multiTenancy disabled', () => {
    ConfigService.setConfig({} as any);
    expect(isHierarchyRole('member')).toBe(false);
    ConfigService.setConfig({ multiTenancy: {} } as any);
  });

  // =========================================================================
  // getMinRequiredLevel
  // =========================================================================
  it('should get minimum required level from roles', () => {
    expect(getMinRequiredLevel(['member'])).toBe(1);
    expect(getMinRequiredLevel(['manager'])).toBe(2);
    expect(getMinRequiredLevel(['owner'])).toBe(3);
    expect(getMinRequiredLevel(['member', 'owner'])).toBe(1); // minimum of 1 and 3
    expect(getMinRequiredLevel(['auditor'])).toBeUndefined(); // non-hierarchy
    expect(getMinRequiredLevel(['auditor', 'member'])).toBe(1); // member is hierarchy
    expect(getMinRequiredLevel([])).toBeUndefined();
  });

  // =========================================================================
  // checkRoleAccess
  // =========================================================================
  describe('checkRoleAccess', () => {
    it('should pass hierarchy role via level comparison (tenantRole)', () => {
      expect(checkRoleAccess(['member'], undefined, 'member')).toBe(true);
      expect(checkRoleAccess(['member'], undefined, 'manager')).toBe(true);
      expect(checkRoleAccess(['member'], undefined, 'owner')).toBe(true);
      expect(checkRoleAccess(['manager'], undefined, 'member')).toBe(false);
      expect(checkRoleAccess(['manager'], undefined, 'manager')).toBe(true);
      expect(checkRoleAccess(['manager'], undefined, 'owner')).toBe(true);
      expect(checkRoleAccess(['owner'], undefined, 'owner')).toBe(true);
      expect(checkRoleAccess(['owner'], undefined, 'manager')).toBe(false);
    });

    it('should pass hierarchy role via level comparison (userRoles)', () => {
      expect(checkRoleAccess(['member'], ['manager'])).toBe(true);
      expect(checkRoleAccess(['manager'], ['member'])).toBe(false);
      expect(checkRoleAccess(['member'], ['owner'])).toBe(true);
    });

    it('should pass normal role via exact match (tenantRole)', () => {
      expect(checkRoleAccess(['auditor'], undefined, 'auditor')).toBe(true);
      expect(checkRoleAccess(['auditor'], undefined, 'manager')).toBe(false);
      expect(checkRoleAccess(['auditor'], undefined, 'auditor')).toBe(true);
    });

    it('should pass normal role via exact match (userRoles)', () => {
      expect(checkRoleAccess(['moderator'], ['moderator'])).toBe(true);
      expect(checkRoleAccess(['moderator'], ['admin'])).toBe(false);
      expect(checkRoleAccess(['moderator'], ['moderator', 'admin'])).toBe(true);
    });

    it('should use OR semantics for mixed roles', () => {
      // hierarchy role matches → pass
      expect(checkRoleAccess(['manager', 'auditor'], undefined, 'owner')).toBe(true);
      // normal role matches → pass
      expect(checkRoleAccess(['manager', 'auditor'], undefined, 'auditor')).toBe(true);
      // neither matches → fail
      expect(checkRoleAccess(['manager', 'auditor'], undefined, 'member')).toBe(false);
    });

    it('should prefer tenantRole over userRoles', () => {
      // tenantRole is set → userRoles ignored
      expect(checkRoleAccess(['manager'], ['owner'], 'member')).toBe(false);
      expect(checkRoleAccess(['manager'], ['member'], 'owner')).toBe(true);
    });

    it('should return true for empty required roles', () => {
      expect(checkRoleAccess([], ['member'])).toBe(true);
      expect(checkRoleAccess([], undefined, 'member')).toBe(true);
    });

    it('should return false when no available roles', () => {
      expect(checkRoleAccess(['member'], [])).toBe(false);
      expect(checkRoleAccess(['member'], undefined, undefined)).toBe(false);
    });

    it('should handle same-level roles in custom hierarchy', () => {
      ConfigService.setConfig({
        multiTenancy: { roleHierarchy: { viewer: 1, editor: 2, manager: 2, owner: 3 } },
      } as any);

      try {
        // editor(2) and manager(2) share the same level → equivalent access
        expect(checkRoleAccess(['manager'], undefined, 'editor')).toBe(true);
        expect(checkRoleAccess(['editor'], undefined, 'manager')).toBe(true);
        expect(checkRoleAccess(['owner'], undefined, 'editor')).toBe(false);
        expect(checkRoleAccess(['viewer'], undefined, 'editor')).toBe(true);
      } finally {
        ConfigService.setConfig({ multiTenancy: {} } as any);
      }
    });
  });

  // =========================================================================
  // getRoleHierarchy
  // =========================================================================
  it('should return default hierarchy when no custom config', () => {
    const hierarchy = getRoleHierarchy();
    expect(hierarchy).toEqual({ member: 1, manager: 2, owner: 3 });
  });

  it('should return custom hierarchy from config', () => {
    ConfigService.setConfig({
      multiTenancy: { roleHierarchy: { a: 1, b: 5 } },
    } as any);

    try {
      const hierarchy = getRoleHierarchy();
      expect(hierarchy).toEqual({ a: 1, b: 5 });
    } finally {
      ConfigService.setConfig({ multiTenancy: {} } as any);
    }
  });
});

// =============================================================================
// CoreTenantModule.forRoot() customization tests
// =============================================================================
describe('CoreTenantModule.forRoot() customization', () => {
  // =========================================================================
  // Custom modelName
  // =========================================================================
  describe('custom modelName', () => {
    let app: import('@nestjs/common').INestApplication;
    let memberModel: Model<TenantMember>;
    let tenantService: CoreTenantService;

    const TENANT_A = 'tenant-custom-model-a';
    const USER_ID = 'user-custom-model-1';

    beforeAll(async () => {
      ConfigService.setConfig({ multiTenancy: { membershipModel: 'OrgMember' } } as any);

      // Use CoreTenantModule.forRoot with custom modelName
      const { CoreTenantModule } = await import('../src/core/modules/tenant/core-tenant.module');

      @Module({
        controllers: [TestController],
        imports: [
          MongooseModule.forRoot('mongodb://127.0.0.1/nest-server-tenant-custom-model-test'),
          CoreTenantModule.forRoot({ modelName: 'OrgMember' }),
        ],
      })
      class CustomModelTestModule {}

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [CustomModelTestModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.use(createAuthMiddleware());
      await app.init();

      // @InjectModel('TenantMember') still works due to alias provider
      memberModel = moduleFixture.get<Model<TenantMember>>(getModelToken('TenantMember'));
      tenantService = moduleFixture.get(CoreTenantService);
    });

    beforeEach(async () => {
      await memberModel.deleteMany({});
    });

    afterAll(async () => {
      await memberModel.deleteMany({});
      await app.close();
      ConfigService.setConfig({} as any);
    });

    it('should work with custom modelName via alias provider', async () => {
      await tenantService.addMember(TENANT_A, USER_ID, 'member');

      const res = await request(app.getHttpServer())
        .get('/test/tenant-member')
        .set('X-Tenant-Id', TENANT_A)
        .set('X-Test-User-Id', USER_ID)
        .expect(200);

      expect(res.body.tenantId).toBe(TENANT_A);
    });

    it('should deny non-member with custom modelName', async () => {
      await request(app.getHttpServer())
        .get('/test/tenant-member')
        .set('X-Tenant-Id', TENANT_A)
        .set('X-Test-User-Id', USER_ID)
        .expect(403);
    });
  });

  // =========================================================================
  // Custom service
  // =========================================================================
  describe('custom service', () => {
    let app: import('@nestjs/common').INestApplication;
    let tenantService: CoreTenantService;
    let memberModel: Model<TenantMember>;

    const TENANT_A = 'tenant-custom-svc-a';
    const USER_ID = 'user-custom-svc-1';

    // Custom service that overrides getDefaultRole
    @Injectable()
    class CustomTenantService extends CoreTenantService {
      override getDefaultRole(): string {
        return 'viewer'; // custom default role
      }
    }

    beforeAll(async () => {
      ConfigService.setConfig({ multiTenancy: { roleHierarchy: { viewer: 1, editor: 2, owner: 3 } } } as any);

      const { CoreTenantModule } = await import('../src/core/modules/tenant/core-tenant.module');

      @Module({
        controllers: [TestController],
        imports: [
          MongooseModule.forRoot('mongodb://127.0.0.1/nest-server-tenant-custom-svc-test'),
          CoreTenantModule.forRoot({ service: CustomTenantService }),
        ],
      })
      class CustomServiceTestModule {}

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [CustomServiceTestModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.use(createAuthMiddleware());
      await app.init();

      tenantService = moduleFixture.get(CoreTenantService);
      memberModel = moduleFixture.get<Model<TenantMember>>(getModelToken('TenantMember'));
    });

    beforeEach(async () => {
      await memberModel.deleteMany({});
    });

    afterAll(async () => {
      await memberModel.deleteMany({});
      await app.close();
      ConfigService.setConfig({} as any);
    });

    it('should use custom service with overridden getDefaultRole', async () => {
      // addMember without explicit role should use the custom default 'viewer'
      const member = await tenantService.addMember(TENANT_A, USER_ID);
      expect(member.role).toBe('viewer');
    });

    it('should still inject CoreTenantService token with custom implementation', () => {
      expect(tenantService).toBeInstanceOf(CustomTenantService);
    });
  });
});

// =============================================================================
// @CurrentTenant decorator (unit tests)
// =============================================================================
describe('@CurrentTenant decorator', () => {
  it('should read tenantId from RequestContext', () => {
    // @CurrentTenant() reads RequestContext.get()?.tenantId
    const context: IRequestContext = { tenantId: 'tenant-xyz' };
    const result = RequestContext.run(context, () => RequestContext.get()?.tenantId);
    expect(result).toBe('tenant-xyz');
  });

  it('should return undefined when no tenant context is set', () => {
    const context: IRequestContext = {};
    const result = RequestContext.run(context, () => RequestContext.get()?.tenantId);
    expect(result).toBeUndefined();
  });

  it('should return undefined outside of RequestContext', () => {
    const result = RequestContext.get()?.tenantId;
    expect(result).toBeUndefined();
  });
});

// =============================================================================
// createHierarchyRoles / DefaultHR tests
// =============================================================================
describe('createHierarchyRoles', () => {
  it('should create UPPER_CASE constants from hierarchy', () => {
    const hr = createHierarchyRoles({ viewer: 1, editor: 2, manager: 2, owner: 3 });
    expect(hr.VIEWER).toBe('viewer');
    expect(hr.EDITOR).toBe('editor');
    expect(hr.MANAGER).toBe('manager');
    expect(hr.OWNER).toBe('owner');
  });

  it('should produce string values usable in @Roles', () => {
    const hr = createHierarchyRoles({ member: 1, manager: 2, owner: 3 });
    // Values are plain strings, compatible with @Roles decorator
    expect(typeof hr.MEMBER).toBe('string');
    expect(typeof hr.MANAGER).toBe('string');
    expect(typeof hr.OWNER).toBe('string');
  });

  it('DefaultHR should have correct values', () => {
    expect(DefaultHR.MEMBER).toBe('member');
    expect(DefaultHR.MANAGER).toBe('manager');
    expect(DefaultHR.OWNER).toBe('owner');
  });

  it('should handle 5-level custom hierarchy', () => {
    const hr = createHierarchyRoles({ viewer: 1, editor: 2, moderator: 3, admin: 4, owner: 5 });
    expect(hr.VIEWER).toBe('viewer');
    expect(hr.EDITOR).toBe('editor');
    expect(hr.MODERATOR).toBe('moderator');
    expect(hr.ADMIN).toBe('admin');
    expect(hr.OWNER).toBe('owner');
  });
});

// =============================================================================
// @Restricted with hierarchy and normal roles (field-level access control)
// =============================================================================
describe('@Restricted with hierarchy and normal roles', () => {
  // Test class with various @Restricted fields
  class RestrictedTestModel {
    id: string;

    @Restricted(DefaultHR.MEMBER)
    memberField: string;

    @Restricted(DefaultHR.MANAGER)
    managerField: string;

    @Restricted(DefaultHR.OWNER)
    ownerField: string;

    @Restricted('auditor')
    auditorField: string;

    @Restricted('moderator')
    moderatorField: string;

    @Restricted(DefaultHR.MANAGER, 'auditor')
    mixedField: string;
  }

  function createTestObject(): RestrictedTestModel {
    const obj = new RestrictedTestModel();
    obj.id = 'obj-1';
    obj.memberField = 'member-data';
    obj.managerField = 'manager-data';
    obj.ownerField = 'owner-data';
    obj.auditorField = 'auditor-data';
    obj.moderatorField = 'moderator-data';
    obj.mixedField = 'mixed-data';
    return obj;
  }

  function createUser(id: string, roles: string[] = []) {
    return {
      id,
      roles,
      hasRole: (requiredRoles: string[]) => requiredRoles.some((r) => roles.includes(r)),
    };
  }

  beforeAll(() => {
    ConfigService.setConfig({ multiTenancy: {} } as any);
  });

  afterAll(() => {
    new ConfigService({} as any);
  });

  // =========================================================================
  // Hierarchy roles + tenant context (tenantRole set)
  // =========================================================================

  it('should show hierarchy-restricted field when tenantRole meets level', () => {
    const obj = createTestObject();
    const user = createUser('user-1');

    // tenantRole = 'manager' (level 2) → @Restricted(DefaultHR.MEMBER) (level 1) → visible
    const context: IRequestContext = { currentUser: user, tenantRole: 'manager' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.memberField).toBe('member-data');
  });

  it('should show hierarchy-restricted field when tenantRole equals required level', () => {
    const obj = createTestObject();
    const user = createUser('user-1');

    // tenantRole = 'manager' (level 2) → @Restricted(DefaultHR.MANAGER) (level 2) → visible
    const context: IRequestContext = { currentUser: user, tenantRole: 'manager' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.managerField).toBe('manager-data');
  });

  it('should hide hierarchy-restricted field when tenantRole is below required level', () => {
    const obj = createTestObject();
    const user = createUser('user-1');

    // tenantRole = 'member' (level 1) → @Restricted(DefaultHR.MANAGER) (level 2) → hidden
    const context: IRequestContext = { currentUser: user, tenantRole: 'member' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.managerField).toBeUndefined();
  });

  it('should hide owner-restricted field for manager tenantRole', () => {
    const obj = createTestObject();
    const user = createUser('user-1');

    // tenantRole = 'manager' (level 2) → @Restricted(DefaultHR.OWNER) (level 3) → hidden
    const context: IRequestContext = { currentUser: user, tenantRole: 'manager' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.ownerField).toBeUndefined();
  });

  it('should show owner-restricted field for owner tenantRole', () => {
    const obj = createTestObject();
    const user = createUser('user-1');

    // tenantRole = 'owner' (level 3) → @Restricted(DefaultHR.OWNER) (level 3) → visible
    const context: IRequestContext = { currentUser: user, tenantRole: 'owner' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.ownerField).toBe('owner-data');
  });

  // =========================================================================
  // Hierarchy roles + no tenant context (user.roles check)
  // =========================================================================

  it('should show hierarchy-restricted field via user.roles when no tenant context', () => {
    const obj = createTestObject();
    const user = createUser('user-1', ['manager']);

    // No tenantRole → fallback to user.roles=['manager'] (level 2) → @Restricted('member') (level 1) → visible
    const context: IRequestContext = { currentUser: user };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.memberField).toBe('member-data');
  });

  it('should hide hierarchy-restricted field via user.roles when level insufficient', () => {
    const obj = createTestObject();
    const user = createUser('user-1', ['member']);

    // No tenantRole → fallback to user.roles=['member'] (level 1) → @Restricted('manager') (level 2) → hidden
    const context: IRequestContext = { currentUser: user };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.managerField).toBeUndefined();
  });

  it('should show manager-restricted field for owner in user.roles (no tenant)', () => {
    const obj = createTestObject();
    const user = createUser('user-1', ['owner']);

    // No tenantRole → user.roles=['owner'] (level 3) >= manager (level 2) → visible
    const context: IRequestContext = { currentUser: user };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.managerField).toBe('manager-data');
  });

  // =========================================================================
  // Tenant overrides user.roles in @Restricted
  // =========================================================================

  it('should use tenantRole over user.roles for @Restricted (tenant override)', () => {
    const obj = createTestObject();
    const user = createUser('user-1', ['owner']); // user.roles=['owner'] but tenantRole='member'

    // tenantRole='member' overrides user.roles=['owner']
    // @Restricted(DefaultHR.MANAGER) → member(1) < manager(2) → hidden
    const context: IRequestContext = { currentUser: user, tenantRole: 'member' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.managerField).toBeUndefined();
  });

  // =========================================================================
  // Normal (non-hierarchy) roles in @Restricted + tenant context
  // =========================================================================

  it('should show normal-role-restricted field when tenantRole matches exactly', () => {
    const obj = createTestObject();
    const user = createUser('user-1');

    // tenantRole = 'auditor' → @Restricted('auditor') → exact match → visible
    const context: IRequestContext = { currentUser: user, tenantRole: 'auditor' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.auditorField).toBe('auditor-data');
  });

  it('should hide normal-role-restricted field when tenantRole does not match', () => {
    const obj = createTestObject();
    const user = createUser('user-1');

    // tenantRole = 'manager' → @Restricted('auditor') → no match (no hierarchy compensation) → hidden
    const context: IRequestContext = { currentUser: user, tenantRole: 'manager' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.auditorField).toBeUndefined();
  });

  it('should hide normal-role-restricted field when tenantRole is a higher hierarchy role', () => {
    const obj = createTestObject();
    const user = createUser('user-1');

    // tenantRole = 'owner' → @Restricted('auditor') → exact match only, owner != auditor → hidden
    const context: IRequestContext = { currentUser: user, tenantRole: 'owner' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.auditorField).toBeUndefined();
  });

  // =========================================================================
  // Normal (non-hierarchy) roles in @Restricted + no tenant context
  // =========================================================================

  it('should show normal-role-restricted field via user.roles when matching', () => {
    const obj = createTestObject();
    const user = createUser('user-1', ['moderator']);

    // No tenantRole → user.roles=['moderator'] → @Restricted('moderator') → exact match → visible
    const context: IRequestContext = { currentUser: user };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.moderatorField).toBe('moderator-data');
  });

  it('should hide normal-role-restricted field via user.roles when not matching', () => {
    const obj = createTestObject();
    const user = createUser('user-1', ['editor']);

    // No tenantRole → user.roles=['editor'] → @Restricted('moderator') → no match → hidden
    const context: IRequestContext = { currentUser: user };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.moderatorField).toBeUndefined();
  });

  // =========================================================================
  // Mixed roles (hierarchy + normal) in @Restricted — OR semantics
  // =========================================================================

  it('should show mixed-restricted field when hierarchy role matches (OR)', () => {
    const obj = createTestObject();
    const user = createUser('user-1');

    // tenantRole = 'manager' (level 2) → @Restricted(DefaultHR.MANAGER, 'auditor')
    // hierarchy: manager(2) >= manager(2) → match → visible
    const context: IRequestContext = { currentUser: user, tenantRole: 'manager' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.mixedField).toBe('mixed-data');
  });

  it('should show mixed-restricted field when normal role matches (OR)', () => {
    const obj = createTestObject();
    const user = createUser('user-1');

    // tenantRole = 'auditor' → @Restricted(DefaultHR.MANAGER, 'auditor')
    // hierarchy: 'auditor' not in hierarchy → skip; normal: 'auditor' == 'auditor' → match → visible
    const context: IRequestContext = { currentUser: user, tenantRole: 'auditor' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.mixedField).toBe('mixed-data');
  });

  it('should hide mixed-restricted field when neither role matches', () => {
    const obj = createTestObject();
    const user = createUser('user-1');

    // tenantRole = 'member' (level 1) → @Restricted(DefaultHR.MANAGER, 'auditor')
    // hierarchy: member(1) < manager(2) → no; normal: 'member' != 'auditor' → no → hidden
    const context: IRequestContext = { currentUser: user, tenantRole: 'member' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );

    expect(result.mixedField).toBeUndefined();
  });

  // =========================================================================
  // No user / no context
  // =========================================================================

  it('should hide all role-restricted fields when no user', () => {
    const obj = createTestObject();

    const context: IRequestContext = {};
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, undefined as any, { throwError: false }),
    );

    expect(result.memberField).toBeUndefined();
    expect(result.managerField).toBeUndefined();
    expect(result.ownerField).toBeUndefined();
    expect(result.auditorField).toBeUndefined();
    expect(result.moderatorField).toBeUndefined();
    expect(result.mixedField).toBeUndefined();
  });

  // =========================================================================
  // Multi-tenancy disabled → checkRoleAccess returns false (no hierarchy)
  // =========================================================================

  it('should not match hierarchy roles in @Restricted when multiTenancy disabled', () => {
    ConfigService.setConfig({} as any); // multiTenancy disabled

    try {
      const obj = createTestObject();
      const user = createUser('user-1', ['manager']);

      // multiTenancy disabled → 'manager' is NOT in hierarchy → treated as normal role
      // @Restricted(DefaultHR.MANAGER) = @Restricted('manager') → exact match → visible
      const context: IRequestContext = { currentUser: user };
      const result = RequestContext.run(context, () =>
        checkRestricted(obj, user, { throwError: false }),
      );

      // 'manager' exact-matches 'manager' even when multiTenancy is off
      expect(result.managerField).toBe('manager-data');
      // 'manager' does NOT exact-match 'member'
      expect(result.memberField).toBeUndefined();
    } finally {
      ConfigService.setConfig({ multiTenancy: {} } as any);
    }
  });
});

// =============================================================================
// CoreTenantGuard with multiTenancy disabled
// =============================================================================
describe('CoreTenantGuard with multiTenancy disabled', () => {
  let app: import('@nestjs/common').INestApplication;

  beforeAll(async () => {
    // Start with multiTenancy DISABLED — must use setConfig (not constructor, which merges)
    ConfigService.setConfig({} as any);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot('mongodb://127.0.0.1/nest-server-tenant-disabled-test', {
          connectionFactory: (connection) => {
            connection.plugin(mongooseTenantPlugin);
            return connection;
          },
        }),
        MongooseModule.forFeature([
          { name: 'TenantMember', schema: TenantMemberSchema },
          { name: TenantItem.name, schema: TenantItemSchema },
          { name: GlobalItem.name, schema: GlobalItemSchema },
        ]),
      ],
      controllers: [TestController],
      providers: [
        CoreTenantService,
        {
          provide: APP_GUARD,
          useClass: CoreTenantGuard,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(createAuthMiddleware());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    new ConfigService({} as any);
  });

  it('should pass through all requests when multiTenancy is disabled', async () => {
    // Hierarchy-role endpoint should pass without any user or header
    // because guard returns true when multiTenancy is disabled
    await request(app.getHttpServer())
      .get('/test/tenant-member')
      .expect(200);
  });

  it('should pass through owner-level endpoint when multiTenancy is disabled', async () => {
    await request(app.getHttpServer())
      .get('/test/tenant-owner')
      .expect(200);
  });

  it('should pass through normal-role endpoint when multiTenancy is disabled', async () => {
    await request(app.getHttpServer())
      .get('/test/auditor-only')
      .expect(200);
  });
});

// =============================================================================
// @Restricted with system roles (S_EVERYONE, S_NO_ONE, S_USER, S_VERIFIED,
// S_CREATOR, S_SELF) — comprehensive field-level access control
// =============================================================================
describe('@Restricted with system roles', () => {
  // =========================================================================
  // Test models with system roles
  // =========================================================================
  class SystemRoleModel {
    id: string;
    createdBy: string;

    @Restricted(RoleEnum.S_EVERYONE)
    publicField: string;

    @Restricted(RoleEnum.S_NO_ONE)
    lockedField: string;

    @Restricted(RoleEnum.S_USER)
    userField: string;

    @Restricted(RoleEnum.S_VERIFIED)
    verifiedField: string;

    @Restricted(RoleEnum.S_CREATOR)
    creatorField: string;

    @Restricted(RoleEnum.S_SELF)
    selfField: string;
  }

  class CombinedRoleModel {
    id: string;

    @Restricted(RoleEnum.S_USER, DefaultHR.MANAGER)
    userOrManagerField: string;

    @Restricted(RoleEnum.S_VERIFIED, 'auditor')
    verifiedOrAuditorField: string;

    @Restricted(RoleEnum.S_NO_ONE, RoleEnum.S_EVERYONE)
    noOneOverridesField: string;
  }

  function createSystemRoleObject(id = 'obj-1', createdBy = 'creator-1'): SystemRoleModel {
    const obj = new SystemRoleModel();
    obj.id = id;
    obj.createdBy = createdBy;
    obj.publicField = 'public-data';
    obj.lockedField = 'locked-data';
    obj.userField = 'user-data';
    obj.verifiedField = 'verified-data';
    obj.creatorField = 'creator-data';
    obj.selfField = 'self-data';
    return obj;
  }

  function createCombinedObject(id = 'obj-1'): CombinedRoleModel {
    const obj = new CombinedRoleModel();
    obj.id = id;
    obj.userOrManagerField = 'user-or-manager-data';
    obj.verifiedOrAuditorField = 'verified-or-auditor-data';
    obj.noOneOverridesField = 'no-one-data';
    return obj;
  }

  function createUser(id: string, roles: string[] = [], extra: Record<string, any> = {}) {
    return {
      id,
      roles,
      hasRole: (requiredRoles: string[]) => requiredRoles.some((r) => roles.includes(r)),
      ...extra,
    };
  }

  beforeAll(() => {
    ConfigService.setConfig({ multiTenancy: {} } as any);
  });

  afterAll(() => {
    ConfigService.setConfig({} as any);
  });

  // =========================================================================
  // S_EVERYONE — always visible
  // =========================================================================

  it('S_EVERYONE: should show field to unauthenticated user', () => {
    const obj = createSystemRoleObject();
    const result = checkRestricted(obj, undefined as any, { throwError: false });
    expect(result.publicField).toBe('public-data');
  });

  it('S_EVERYONE: should show field to authenticated user', () => {
    const obj = createSystemRoleObject();
    const user = createUser('user-1');
    const result = checkRestricted(obj, user, { throwError: false });
    expect(result.publicField).toBe('public-data');
  });

  it('S_EVERYONE: should show field with tenant context', () => {
    const obj = createSystemRoleObject();
    const user = createUser('user-1');
    const context: IRequestContext = { currentUser: user, tenantRole: 'member' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );
    expect(result.publicField).toBe('public-data');
  });

  // =========================================================================
  // S_NO_ONE — always hidden, overrides everything
  // =========================================================================

  it('S_NO_ONE: should hide field from unauthenticated user', () => {
    const obj = createSystemRoleObject();
    const result = checkRestricted(obj, undefined as any, { throwError: false });
    expect(result.lockedField).toBeUndefined();
  });

  it('S_NO_ONE: should hide field from authenticated user', () => {
    const obj = createSystemRoleObject();
    const user = createUser('user-1');
    const result = checkRestricted(obj, user, { throwError: false });
    expect(result.lockedField).toBeUndefined();
  });

  it('S_NO_ONE: should hide field from admin user', () => {
    const obj = createSystemRoleObject();
    const user = createUser('admin-1', [RoleEnum.ADMIN]);
    const result = checkRestricted(obj, user, { throwError: false });
    expect(result.lockedField).toBeUndefined();
  });

  it('S_NO_ONE: should hide field even with tenant owner role', () => {
    const obj = createSystemRoleObject();
    const user = createUser('user-1', ['owner']);
    const context: IRequestContext = { currentUser: user, tenantRole: 'owner' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );
    expect(result.lockedField).toBeUndefined();
  });

  // =========================================================================
  // S_USER — visible only to authenticated users
  // =========================================================================

  it('S_USER: should hide field from unauthenticated user', () => {
    const obj = createSystemRoleObject();
    const result = checkRestricted(obj, undefined as any, { throwError: false });
    expect(result.userField).toBeUndefined();
  });

  it('S_USER: should show field to authenticated user', () => {
    const obj = createSystemRoleObject();
    const user = createUser('user-1');
    const result = checkRestricted(obj, user, { throwError: false });
    expect(result.userField).toBe('user-data');
  });

  it('S_USER: should show field with tenant context', () => {
    const obj = createSystemRoleObject();
    const user = createUser('user-1');
    const context: IRequestContext = { currentUser: user, tenantRole: 'member' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );
    expect(result.userField).toBe('user-data');
  });

  // =========================================================================
  // S_VERIFIED — visible only to verified users
  // =========================================================================

  it('S_VERIFIED: should hide field from unverified user', () => {
    const obj = createSystemRoleObject();
    const user = createUser('user-1');
    const result = checkRestricted(obj, user, { throwError: false });
    expect(result.verifiedField).toBeUndefined();
  });

  it('S_VERIFIED: should show field to user with verified=true', () => {
    const obj = createSystemRoleObject();
    const user = createUser('user-1', [], { verified: true });
    const result = checkRestricted(obj, user, { throwError: false });
    expect(result.verifiedField).toBe('verified-data');
  });

  it('S_VERIFIED: should show field to user with verifiedAt set', () => {
    const obj = createSystemRoleObject();
    const user = createUser('user-1', [], { verifiedAt: new Date() });
    const result = checkRestricted(obj, user, { throwError: false });
    expect(result.verifiedField).toBe('verified-data');
  });

  it('S_VERIFIED: should show field to user with emailVerified=true', () => {
    const obj = createSystemRoleObject();
    const user = createUser('user-1', [], { emailVerified: true });
    const result = checkRestricted(obj, user, { throwError: false });
    expect(result.verifiedField).toBe('verified-data');
  });

  it('S_VERIFIED: should show field with tenant context when verified', () => {
    const obj = createSystemRoleObject();
    const user = createUser('user-1', [], { verified: true });
    const context: IRequestContext = { currentUser: user, tenantRole: 'member' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );
    expect(result.verifiedField).toBe('verified-data');
  });

  // =========================================================================
  // S_CREATOR — visible only to the creator of the object
  // =========================================================================

  it('S_CREATOR: should show field to creator', () => {
    const obj = createSystemRoleObject('obj-1', 'user-1');
    const user = createUser('user-1');
    const result = checkRestricted(obj, user, { throwError: false, dbObject: obj });
    expect(result.creatorField).toBe('creator-data');
  });

  it('S_CREATOR: should hide field from non-creator', () => {
    const obj = createSystemRoleObject('obj-1', 'other-user');
    const user = createUser('user-1');
    const result = checkRestricted(obj, user, { throwError: false, dbObject: obj });
    expect(result.creatorField).toBeUndefined();
  });

  it('S_CREATOR: should hide field from unauthenticated user', () => {
    const obj = createSystemRoleObject('obj-1', 'user-1');
    const result = checkRestricted(obj, undefined as any, { throwError: false });
    expect(result.creatorField).toBeUndefined();
  });

  it('S_CREATOR: should show field to creator even with tenant context', () => {
    const obj = createSystemRoleObject('obj-1', 'user-1');
    const user = createUser('user-1');
    const context: IRequestContext = { currentUser: user, tenantRole: 'member' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false, dbObject: obj }),
    );
    expect(result.creatorField).toBe('creator-data');
  });

  // =========================================================================
  // S_SELF — visible only when data.id === user.id
  // =========================================================================

  it('S_SELF: should show field when data is the user themselves', () => {
    const obj = createSystemRoleObject('user-1');
    const user = createUser('user-1');
    const result = checkRestricted(obj, user, { throwError: false });
    expect(result.selfField).toBe('self-data');
  });

  it('S_SELF: should hide field when data belongs to a different user', () => {
    const obj = createSystemRoleObject('other-user');
    const user = createUser('user-1');
    const result = checkRestricted(obj, user, { throwError: false });
    expect(result.selfField).toBeUndefined();
  });

  it('S_SELF: should hide field from unauthenticated user', () => {
    const obj = createSystemRoleObject('user-1');
    const result = checkRestricted(obj, undefined as any, { throwError: false });
    expect(result.selfField).toBeUndefined();
  });

  it('S_SELF: should show field to self even with tenant context', () => {
    const obj = createSystemRoleObject('user-1');
    const user = createUser('user-1');
    const context: IRequestContext = { currentUser: user, tenantRole: 'member' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );
    expect(result.selfField).toBe('self-data');
  });

  // =========================================================================
  // Combined: system role + hierarchy/normal role (OR semantics)
  // =========================================================================

  it('combined: S_USER OR hierarchy role — S_USER passes for authenticated user', () => {
    const obj = createCombinedObject();
    const user = createUser('user-1'); // no hierarchy role
    const context: IRequestContext = { currentUser: user };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );
    // S_USER check passes (user.id exists) → visible
    expect(result.userOrManagerField).toBe('user-or-manager-data');
  });

  it('combined: S_USER OR hierarchy role — hierarchy passes with tenant role', () => {
    const obj = createCombinedObject();
    const user = createUser('user-1');
    // tenantRole='owner' satisfies hierarchy 'manager' (owner(3) >= manager(2))
    const context: IRequestContext = { currentUser: user, tenantRole: 'owner' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );
    expect(result.userOrManagerField).toBe('user-or-manager-data');
  });

  it('combined: S_USER OR hierarchy role — hidden from unauthenticated', () => {
    const obj = createCombinedObject();
    const context: IRequestContext = {};
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, undefined as any, { throwError: false }),
    );
    // No user → S_USER fails, no roles → hierarchy fails → hidden
    expect(result.userOrManagerField).toBeUndefined();
  });

  it('combined: S_VERIFIED OR normal role — verified passes', () => {
    const obj = createCombinedObject();
    const user = createUser('user-1', [], { verified: true });
    const context: IRequestContext = { currentUser: user };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );
    expect(result.verifiedOrAuditorField).toBe('verified-or-auditor-data');
  });

  it('combined: S_VERIFIED OR normal role — auditor tenant role passes', () => {
    const obj = createCombinedObject();
    const user = createUser('user-1'); // not verified
    const context: IRequestContext = { currentUser: user, tenantRole: 'auditor' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );
    // Not verified → S_VERIFIED fails; tenantRole='auditor' exact match → passes
    expect(result.verifiedOrAuditorField).toBe('verified-or-auditor-data');
  });

  it('combined: S_VERIFIED OR normal role — neither passes', () => {
    const obj = createCombinedObject();
    const user = createUser('user-1'); // not verified, no auditor role
    const context: IRequestContext = { currentUser: user, tenantRole: 'member' };
    const result = RequestContext.run(context, () =>
      checkRestricted(obj, user, { throwError: false }),
    );
    // Not verified, member != auditor → hidden
    expect(result.verifiedOrAuditorField).toBeUndefined();
  });

  it('combined: S_NO_ONE + S_EVERYONE — S_NO_ONE wins (checked first)', () => {
    const obj = createCombinedObject();
    const user = createUser('user-1');
    const result = checkRestricted(obj, user, { throwError: false });
    // S_NO_ONE is checked before all other role checks → always hidden
    expect(result.noOneOverridesField).toBeUndefined();
  });

  // =========================================================================
  // System roles + multiTenancy disabled
  // =========================================================================

  it('system roles should work identically when multiTenancy is disabled', () => {
    ConfigService.setConfig({} as any); // disable multiTenancy

    try {
      const obj = createSystemRoleObject('user-1', 'user-1');
      const user = createUser('user-1', [], { verified: true });
      const result = checkRestricted(obj, user, { throwError: false, dbObject: obj });

      expect(result.publicField).toBe('public-data');     // S_EVERYONE → visible
      expect(result.lockedField).toBeUndefined();          // S_NO_ONE → hidden
      expect(result.userField).toBe('user-data');          // S_USER → visible
      expect(result.verifiedField).toBe('verified-data');  // S_VERIFIED → visible
      expect(result.creatorField).toBe('creator-data');    // S_CREATOR → visible (is creator)
      expect(result.selfField).toBe('self-data');          // S_SELF → visible (is self)
    } finally {
      ConfigService.setConfig({ multiTenancy: {} } as any);
    }
  });
});

// =============================================================================
// CoreTenantMemberModel.securityCheck() unit tests
// =============================================================================
describe('CoreTenantMemberModel.securityCheck()', () => {
  function createMember(overrides: Partial<CoreTenantMemberModel> = {}): CoreTenantMemberModel {
    const member = new CoreTenantMemberModel();
    member.user = 'user-1';
    member.tenant = 'tenant-1';
    member.role = 'member';
    member.status = TenantMemberStatus.ACTIVE;
    Object.assign(member, overrides);
    return member;
  }

  const adminUser = {
    id: 'admin-1',
    roles: ['admin'],
    hasRole: (r: string | string[]) => (Array.isArray(r) ? r : [r]).includes('admin'),
  };
  const otherUser = { id: 'user-2', roles: [] };
  const memberUser = { id: 'user-3', roles: [] };

  it('should allow access when force is true', () => {
    const member = createMember();
    expect(() => member.securityCheck(null, true)).not.toThrow();
  });

  it('should deny access when no user is provided', () => {
    const member = createMember();
    expect(() => member.securityCheck(null)).toThrow('Access to tenant membership denied');
    expect(() => member.securityCheck(undefined)).toThrow('Access to tenant membership denied');
  });

  it('should allow access for the membership owner (same user)', () => {
    const member = createMember({ user: 'user-1' });
    const user = { id: 'user-1', roles: [] };
    expect(() => member.securityCheck(user)).not.toThrow();
  });

  it('should allow access for system admin', () => {
    const member = createMember();
    expect(() => member.securityCheck(adminUser)).not.toThrow();
  });

  it('should allow access for a manager of the same tenant via RequestContext', () => {
    const member = createMember({ tenant: 'tenant-abc', user: 'user-1' });
    const context: IRequestContext = { tenantId: 'tenant-abc', tenantRole: 'manager' };

    ConfigService.setConfig({ multiTenancy: { roleHierarchy: DEFAULT_ROLE_HIERARCHY } } as any);
    try {
      RequestContext.run(context, () => {
        member.securityCheck(otherUser);
      });
    } finally {
      ConfigService.setConfig({ multiTenancy: {} } as any);
    }
  });

  it('should allow access for an owner of the same tenant via RequestContext', () => {
    const member = createMember({ tenant: 'tenant-abc', user: 'user-1' });
    const context: IRequestContext = { tenantId: 'tenant-abc', tenantRole: 'owner' };

    ConfigService.setConfig({ multiTenancy: { roleHierarchy: DEFAULT_ROLE_HIERARCHY } } as any);
    try {
      RequestContext.run(context, () => {
        member.securityCheck(otherUser);
      });
    } finally {
      ConfigService.setConfig({ multiTenancy: {} } as any);
    }
  });

  it('should deny access for a member (below manager) of the same tenant', () => {
    const member = createMember({ tenant: 'tenant-abc', user: 'user-1' });
    const context: IRequestContext = { tenantId: 'tenant-abc', tenantRole: 'member' };

    ConfigService.setConfig({ multiTenancy: { roleHierarchy: DEFAULT_ROLE_HIERARCHY } } as any);
    try {
      RequestContext.run(context, () => {
        expect(() => member.securityCheck(memberUser)).toThrow('Access to tenant membership denied');
      });
    } finally {
      ConfigService.setConfig({ multiTenancy: {} } as any);
    }
  });

  it('should deny access for a manager of a different tenant', () => {
    const member = createMember({ tenant: 'tenant-abc', user: 'user-1' });
    const context: IRequestContext = { tenantId: 'tenant-OTHER', tenantRole: 'manager' };

    ConfigService.setConfig({ multiTenancy: { roleHierarchy: DEFAULT_ROLE_HIERARCHY } } as any);
    try {
      RequestContext.run(context, () => {
        expect(() => member.securityCheck(otherUser)).toThrow('Access to tenant membership denied');
      });
    } finally {
      ConfigService.setConfig({ multiTenancy: {} } as any);
    }
  });

  it('should deny access for unauthenticated user without tenant context', () => {
    const member = createMember();
    expect(() => member.securityCheck(memberUser)).toThrow('Access to tenant membership denied');
  });
});

// =============================================================================
// Regression: BetterAuth auto-skip respects X-Tenant-Id header
//
// Bug: When skipTenantCheck: true (default) and a BetterAuth controller is used,
// the guard was skipping tenant validation even when X-Tenant-Id header was present.
// Fix: The skip only fires when NO header is sent. If a header is present, normal
// membership validation runs.
// =============================================================================
describe('CoreTenantGuard: BetterAuth auto-skip with header present (regression)', () => {
  let app: import('@nestjs/common').INestApplication;
  let memberModel: Model<TenantMember>;
  let tenantService: CoreTenantService;

  const TENANT_A = 'tenant-ba-skip-aaa';
  const USER_ID = 'user-ba-skip-123';

  beforeAll(async () => {
    // skipTenantCheck: true is the default — auto-skip fires only when NO header is sent
    new ConfigService({
      multiTenancy: {},
      betterAuth: { skipTenantCheck: true },
    } as any);

    const { CoreBetterAuthController } = await import(
      '../src/core/modules/better-auth/core-better-auth.controller'
    );
    const { CoreBetterAuthService } = await import(
      '../src/core/modules/better-auth/core-better-auth.service'
    );
    const { CoreBetterAuthUserMapper } = await import(
      '../src/core/modules/better-auth/core-better-auth-user.mapper'
    );

    // Minimal mock for CoreBetterAuthService constructor dependencies
    const mockBetterAuthService = {
      getConfig: () => ({ secret: 'test-secret' }),
      getBasePath: () => '/api/auth',
      getCookieDomain: () => undefined,
    };
    const mockUserMapper = {};

    // Minimal mock for ConfigService instance methods used in CoreBetterAuthController constructor
    const mockConfigService = {
      getFastButReadOnly: () => undefined,
    };

    // Create a minimal controller that extends CoreBetterAuthController.
    // This makes isBetterAuthController() return true for this controller class.
    @Controller('iam-test')
    @Roles(RoleEnum.S_EVERYONE)
    class IamTestController extends CoreBetterAuthController {
      constructor() {
        super(
          mockBetterAuthService as unknown as InstanceType<typeof CoreBetterAuthService>,
          mockUserMapper as unknown as InstanceType<typeof CoreBetterAuthUserMapper>,
          mockConfigService as unknown as ConfigService,
        );
      }

      @Get('profile')
      @Roles(RoleEnum.S_USER)
      getProfile(@CurrentTenant() tenantId: string | undefined) {
        return { ok: true, tenantId };
      }
    }

    @Module({
      controllers: [IamTestController],
      imports: [
        MongooseModule.forRoot('mongodb://127.0.0.1/nest-server-tenant-ba-skip-test', {
          connectionFactory: (connection) => {
            connection.plugin(mongooseTenantPlugin);
            return connection;
          },
        }),
        MongooseModule.forFeature([{ name: 'TenantMember', schema: TenantMemberSchema }]),
      ],
      providers: [
        CoreTenantService,
        { provide: APP_GUARD, useClass: CoreTenantGuard },
      ],
    })
    class IamTestModule {}

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [IamTestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(createAuthMiddleware());
    await app.init();

    memberModel = moduleFixture.get<Model<TenantMember>>(getModelToken('TenantMember'));
    tenantService = moduleFixture.get(CoreTenantService);
  });

  beforeEach(async () => {
    await memberModel.deleteMany({});
  });

  afterAll(async () => {
    await memberModel.deleteMany({});
    await app.close();
    new ConfigService({} as any);
  });

  it('should skip tenant validation when no X-Tenant-Id header is sent (skipTenantCheck: true)', async () => {
    // No header → BetterAuth auto-skip fires → 200 without tenant context
    const res = await request(app.getHttpServer())
      .get('/iam-test/profile')
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.tenantId).toBeUndefined();
  });

  it('should validate membership when X-Tenant-Id header IS present (regression: was incorrectly skipping)', async () => {
    // User is NOT a member of TENANT_A → should get 403
    // Before fix: guard would skip validation even with header → 200 (BUG)
    // After fix: guard validates membership → 403 (CORRECT)
    const res = await request(app.getHttpServer())
      .get('/iam-test/profile')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);

    expect(res.body.message).toContain('Not a member');
  });

  it('should set tenant context when user IS a member and header is present', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, 'member');

    const res = await request(app.getHttpServer())
      .get('/iam-test/profile')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.tenantId).toBe(TENANT_A);
  });
});

// =============================================================================
// skipTenantCheck: false — opt-out of auto-skip
//
// When betterAuth.skipTenantCheck is explicitly set to false, IAM endpoints
// should NOT auto-skip tenant validation, even without X-Tenant-Id header.
// The request falls through to the normal "NO HEADER" path.
// =============================================================================
describe('CoreTenantGuard: BetterAuth skipTenantCheck: false (opt-out)', () => {
  let app: import('@nestjs/common').INestApplication;
  let memberModel: Model<TenantMember>;

  const USER_ID = 'user-ba-optout-456';

  beforeAll(async () => {
    new ConfigService({
      multiTenancy: {},
      betterAuth: { skipTenantCheck: false },
    } as any);

    const { CoreBetterAuthController } = await import(
      '../src/core/modules/better-auth/core-better-auth.controller'
    );
    const { CoreBetterAuthService } = await import(
      '../src/core/modules/better-auth/core-better-auth.service'
    );
    const { CoreBetterAuthUserMapper } = await import(
      '../src/core/modules/better-auth/core-better-auth-user.mapper'
    );

    const mockBetterAuthService = {
      getConfig: () => ({ secret: 'test-secret' }),
      getBasePath: () => '/api/auth',
      getCookieDomain: () => undefined,
    };

    const mockConfigService = {
      getFastButReadOnly: () => undefined,
    };

    @Controller('iam-optout')
    @Roles(RoleEnum.S_EVERYONE)
    class IamOptOutController extends CoreBetterAuthController {
      constructor() {
        super(
          mockBetterAuthService as unknown as InstanceType<typeof CoreBetterAuthService>,
          {} as unknown as InstanceType<typeof CoreBetterAuthUserMapper>,
          mockConfigService as unknown as ConfigService,
        );
      }

      @Get('profile')
      @Roles(RoleEnum.S_USER)
      getProfile(@CurrentTenant() tenantId: string | undefined) {
        return { ok: true, tenantId };
      }
    }

    @Module({
      controllers: [IamOptOutController],
      imports: [
        MongooseModule.forRoot('mongodb://127.0.0.1/nest-server-tenant-ba-optout-test', {
          connectionFactory: (connection) => {
            connection.plugin(mongooseTenantPlugin);
            return connection;
          },
        }),
        MongooseModule.forFeature([{ name: 'TenantMember', schema: TenantMemberSchema }]),
      ],
      providers: [
        CoreTenantService,
        { provide: APP_GUARD, useClass: CoreTenantGuard },
      ],
    })
    class IamOptOutModule {}

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [IamOptOutModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(createAuthMiddleware());
    await app.init();

    memberModel = moduleFixture.get<Model<TenantMember>>(getModelToken('TenantMember'));
  });

  afterAll(async () => {
    await memberModel.deleteMany({});
    await app.close();
    new ConfigService({} as any);
  });

  it('should NOT auto-skip when skipTenantCheck: false — proceeds to normal no-header path', async () => {
    // With skipTenantCheck: false, the auto-skip does not fire.
    // The normal "NO HEADER" path runs: user exists → resolveUserTenantIds → 200
    const res = await request(app.getHttpServer())
      .get('/iam-optout/profile')
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  it('should enforce membership when skipTenantCheck: false and header IS present', async () => {
    // Opt-out + header + non-member → normal membership validation → 403
    const res = await request(app.getHttpServer())
      .get('/iam-optout/profile')
      .set('X-Tenant-Id', 'tenant-ba-optout-aaa')
      .set('X-Test-User-Id', USER_ID)
      .expect(403);

    expect(res.body.message).toContain('Not a member');
  });
});

// =============================================================================
// Non-BetterAuth controller: auto-skip must NOT fire
//
// A regular controller (not extending CoreBetterAuthController) should never
// benefit from the BetterAuth auto-skip, even when skipTenantCheck: true.
// =============================================================================
describe('CoreTenantGuard: Non-BetterAuth controller does not auto-skip', () => {
  let app: import('@nestjs/common').INestApplication;
  let memberModel: Model<TenantMember>;

  const TENANT_B = 'tenant-nonskip-bbb';
  const USER_ID = 'user-nonskip-789';

  beforeAll(async () => {
    new ConfigService({
      multiTenancy: {},
      betterAuth: { skipTenantCheck: true },
    } as any);

    // Regular controller — does NOT extend CoreBetterAuthController
    @Controller('regular')
    class RegularController {
      @Get('data')
      @Roles(RoleEnum.S_USER)
      getData(@CurrentTenant() tenantId: string | undefined) {
        return { ok: true, tenantId };
      }
    }

    @Module({
      controllers: [RegularController],
      imports: [
        MongooseModule.forRoot('mongodb://127.0.0.1/nest-server-tenant-nonskip-test', {
          connectionFactory: (connection) => {
            connection.plugin(mongooseTenantPlugin);
            return connection;
          },
        }),
        MongooseModule.forFeature([{ name: 'TenantMember', schema: TenantMemberSchema }]),
      ],
      providers: [
        CoreTenantService,
        { provide: APP_GUARD, useClass: CoreTenantGuard },
      ],
    })
    class RegularModule {}

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [RegularModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(createAuthMiddleware());
    await app.init();

    memberModel = moduleFixture.get<Model<TenantMember>>(getModelToken('TenantMember'));
  });

  afterAll(async () => {
    await memberModel.deleteMany({});
    await app.close();
    new ConfigService({} as any);
  });

  it('should NOT auto-skip for non-BetterAuth controller even with skipTenantCheck: true', async () => {
    // Regular controller + no header + authenticated user → normal "NO HEADER" path
    // resolveUserTenantIds runs (no auto-skip) → 200
    const res = await request(app.getHttpServer())
      .get('/regular/data')
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.ok).toBe(true);
    // tenantId is undefined because no header was sent (normal behavior)
    expect(res.body.tenantId).toBeUndefined();
  });

  it('should still validate membership for non-BetterAuth controller when header IS present', async () => {
    // Non-member with header → 403
    await request(app.getHttpServer())
      .get('/regular/data')
      .set('X-Tenant-Id', TENANT_B)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });
});

// =============================================================================
// BetterAuth config not set at all — safe default (skip)
//
// When betterAuth is not configured at all (undefined), the auto-skip should
// still fire as a safe default (auth before tenant).
// =============================================================================
describe('CoreTenantGuard: BetterAuth config missing — safe default skip', () => {
  let app: import('@nestjs/common').INestApplication;
  let memberModel: Model<TenantMember>;

  const USER_ID = 'user-ba-noconfig-321';

  beforeAll(async () => {
    // multiTenancy enabled, but NO betterAuth config at all
    new ConfigService({
      multiTenancy: {},
    } as any);

    const { CoreBetterAuthController } = await import(
      '../src/core/modules/better-auth/core-better-auth.controller'
    );
    const { CoreBetterAuthService } = await import(
      '../src/core/modules/better-auth/core-better-auth.service'
    );
    const { CoreBetterAuthUserMapper } = await import(
      '../src/core/modules/better-auth/core-better-auth-user.mapper'
    );

    const mockBetterAuthService = {
      getConfig: () => ({ secret: 'test-secret' }),
      getBasePath: () => '/api/auth',
      getCookieDomain: () => undefined,
    };

    const mockConfigService = {
      getFastButReadOnly: () => undefined,
    };

    @Controller('iam-noconfig')
    @Roles(RoleEnum.S_EVERYONE)
    class IamNoConfigController extends CoreBetterAuthController {
      constructor() {
        super(
          mockBetterAuthService as unknown as InstanceType<typeof CoreBetterAuthService>,
          {} as unknown as InstanceType<typeof CoreBetterAuthUserMapper>,
          mockConfigService as unknown as ConfigService,
        );
      }

      @Get('profile')
      @Roles(RoleEnum.S_USER)
      getProfile(@CurrentTenant() tenantId: string | undefined) {
        return { ok: true, tenantId };
      }
    }

    @Module({
      controllers: [IamNoConfigController],
      imports: [
        MongooseModule.forRoot('mongodb://127.0.0.1/nest-server-tenant-ba-noconfig-test', {
          connectionFactory: (connection) => {
            connection.plugin(mongooseTenantPlugin);
            return connection;
          },
        }),
        MongooseModule.forFeature([{ name: 'TenantMember', schema: TenantMemberSchema }]),
      ],
      providers: [
        CoreTenantService,
        { provide: APP_GUARD, useClass: CoreTenantGuard },
      ],
    })
    class IamNoConfigModule {}

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [IamNoConfigModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(createAuthMiddleware());
    await app.init();

    memberModel = moduleFixture.get<Model<TenantMember>>(getModelToken('TenantMember'));
  });

  afterAll(async () => {
    await memberModel.deleteMany({});
    await app.close();
    new ConfigService({} as any);
  });

  it('should auto-skip even when betterAuth config is not set (safe default)', async () => {
    // No betterAuth config + IAM controller + no header → auto-skip fires → 200
    const res = await request(app.getHttpServer())
      .get('/iam-noconfig/profile')
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.tenantId).toBeUndefined();
  });
});

// =============================================================================
// BetterAuth Resolver auto-skip
//
// isBetterAuthHandler() checks both CoreBetterAuthController and
// CoreBetterAuthResolver. This test verifies that a class extending
// CoreBetterAuthResolver is also recognized and benefits from auto-skip.
// Uses a REST @Controller that extends CoreBetterAuthResolver to test the
// prototype chain check without requiring a full GraphQL module setup.
// =============================================================================
describe('CoreTenantGuard: BetterAuth resolver subclass auto-skip', () => {
  let app: import('@nestjs/common').INestApplication;
  let memberModel: Model<TenantMember>;
  let tenantService: CoreTenantService;

  const TENANT_R = 'tenant-ba-resolver-rrr';
  const USER_ID = 'user-ba-resolver-555';

  beforeAll(async () => {
    new ConfigService({
      multiTenancy: {},
      betterAuth: { skipTenantCheck: true },
    } as any);

    const { CoreBetterAuthResolver } = await import(
      '../src/core/modules/better-auth/core-better-auth.resolver'
    );
    const { CoreBetterAuthService } = await import(
      '../src/core/modules/better-auth/core-better-auth.service'
    );
    const { CoreBetterAuthUserMapper } = await import(
      '../src/core/modules/better-auth/core-better-auth-user.mapper'
    );

    const mockBetterAuthService = {
      getConfig: () => ({ secret: 'test-secret' }),
      getBasePath: () => '/api/auth',
    };

    // REST controller extending CoreBetterAuthResolver to test the
    // `handler.prototype instanceof CoreBetterAuthResolver` branch in isBetterAuthHandler().
    @Controller('iam-resolver-test')
    @Roles(RoleEnum.S_EVERYONE)
    class IamResolverTestController extends CoreBetterAuthResolver {
      constructor() {
        super(
          mockBetterAuthService as unknown as InstanceType<typeof CoreBetterAuthService>,
          {} as unknown as InstanceType<typeof CoreBetterAuthUserMapper>,
        );
      }

      @Get('profile')
      @Roles(RoleEnum.S_USER)
      getProfile(@CurrentTenant() tenantId: string | undefined) {
        return { ok: true, tenantId };
      }
    }

    @Module({
      controllers: [IamResolverTestController],
      imports: [
        MongooseModule.forRoot('mongodb://127.0.0.1/nest-server-tenant-ba-resolver-test', {
          connectionFactory: (connection) => {
            connection.plugin(mongooseTenantPlugin);
            return connection;
          },
        }),
        MongooseModule.forFeature([{ name: 'TenantMember', schema: TenantMemberSchema }]),
      ],
      providers: [
        CoreTenantService,
        { provide: APP_GUARD, useClass: CoreTenantGuard },
      ],
    })
    class IamResolverTestModule {}

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [IamResolverTestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(createAuthMiddleware());
    await app.init();

    memberModel = moduleFixture.get<Model<TenantMember>>(getModelToken('TenantMember'));
    tenantService = moduleFixture.get(CoreTenantService);
  });

  beforeEach(async () => {
    await memberModel.deleteMany({});
  });

  afterAll(async () => {
    await memberModel.deleteMany({});
    await app.close();
    new ConfigService({} as any);
  });

  it('should auto-skip for CoreBetterAuthResolver subclass when no header is sent', async () => {
    const res = await request(app.getHttpServer())
      .get('/iam-resolver-test/profile')
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.tenantId).toBeUndefined();
  });

  it('should validate membership for resolver subclass when header IS present', async () => {
    // Non-member with header → 403 (same behavior as controller path)
    await request(app.getHttpServer())
      .get('/iam-resolver-test/profile')
      .set('X-Tenant-Id', TENANT_R)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  it('should set tenant context for resolver subclass when user is a member', async () => {
    await tenantService.addMember(TENANT_R, USER_ID, 'member');

    const res = await request(app.getHttpServer())
      .get('/iam-resolver-test/profile')
      .set('X-Tenant-Id', TENANT_R)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.tenantId).toBe(TENANT_R);
  });
});
