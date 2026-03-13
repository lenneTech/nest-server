import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule, Schema, SchemaFactory, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';
import request from 'supertest';

import { RoleEnum } from '../src/core/common/enums/role.enum';
import { ConfigService } from '../src/core/common/services/config.service';
import { IRequestContext, RequestContext } from '../src/core/common/services/request-context.service';
import { CoreTenantMemberModel } from '../src/core/modules/tenant/core-tenant-member.model';
import { CoreTenantGuard } from '../src/core/modules/tenant/core-tenant.guard';
import { CurrentTenant, TenantRoles } from '../src/core/modules/tenant/core-tenant.decorators';
import { TenantMemberStatus, TenantRole, TENANT_ROLE_HIERARCHY } from '../src/core/modules/tenant/core-tenant.enums';
import { CoreTenantService } from '../src/core/modules/tenant/core-tenant.service';

// =============================================================================
// Test Schema: TenantMember
// =============================================================================
@Schema({ timestamps: true })
class TenantMember extends CoreTenantMemberModel {}

const TenantMemberSchema = SchemaFactory.createForClass(TenantMember);
TenantMemberSchema.index({ user: 1, tenant: 1 }, { unique: true });

// =============================================================================
// Test Controller
// =============================================================================
@Controller('test')
class TestController {
  @Get('public')
  publicEndpoint() {
    return { ok: true };
  }

  @Get('tenant-required')
  @TenantRoles(TenantRole.MEMBER)
  tenantRequired(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  @Get('admin-required')
  @TenantRoles(TenantRole.ADMIN)
  adminRequired(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  @Get('owner-required')
  @TenantRoles(TenantRole.OWNER)
  ownerRequired(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }

  @Get('with-header-no-roles')
  withHeaderNoRoles(@CurrentTenant() tenantId: string) {
    return { ok: true, tenantId };
  }
}

// =============================================================================
// Test Module
// =============================================================================
const TEST_DB_URI = 'mongodb://127.0.0.1/nest-server-tenant-guard-test';

@Module({
  controllers: [TestController],
  imports: [
    MongooseModule.forRoot(TEST_DB_URI),
    MongooseModule.forFeature([{ name: 'TenantMember', schema: TenantMemberSchema }]),
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
// Tests
// =============================================================================
describe('CoreTenantGuard (e2e)', () => {
  let app: import('@nestjs/common').INestApplication;
  let memberModel: Model<TenantMember>;
  let tenantService: CoreTenantService;

  const TENANT_A = 'tenant-aaa';
  const TENANT_B = 'tenant-bbb';
  const USER_ID = 'user-123';
  const ADMIN_USER_ID = 'admin-user-456';

  beforeAll(async () => {
    // Configure with multiTenancy enabled
    new ConfigService({ multiTenancy: {} } as any);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Simulate auth middleware: inject user from custom header for testing
    app.use((req, _res, next) => {
      const userId = req.headers['x-test-user-id'] as string;
      const userRoles = req.headers['x-test-user-roles'] as string;
      if (userId) {
        req.user = {
          id: userId,
          roles: userRoles ? userRoles.split(',') : [],
          hasRole: (roles: string[]) => {
            const r = userRoles ? userRoles.split(',') : [];
            return roles.some((role) => r.includes(role));
          },
        };
      }
      // Wrap in RequestContext
      const context: IRequestContext = {
        get currentUser() {
          return req.user;
        },
        get tenantId() {
          return (req.headers['x-tenant-id'] as string) ?? undefined;
        },
      };
      RequestContext.run(context, () => next());
    });

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
  // Test 1: Public endpoint without tenant header → passes
  // =========================================================================
  it('should allow access to public endpoint without tenant header', async () => {
    const res = await request(app.getHttpServer()).get('/test/public').expect(200);

    expect(res.body.ok).toBe(true);
  });

  // =========================================================================
  // Test 2: Tenant-required endpoint without header → 403
  // =========================================================================
  it('should deny access when @TenantRoles is set but no header provided', async () => {
    await request(app.getHttpServer()).get('/test/tenant-required').set('X-Test-User-Id', USER_ID).expect(403);
  });

  // =========================================================================
  // Test 3: Tenant header but no user → 403
  // =========================================================================
  it('should deny access when tenant header is set but no user', async () => {
    await request(app.getHttpServer()).get('/test/tenant-required').set('X-Tenant-Id', TENANT_A).expect(403);
  });

  // =========================================================================
  // Test 4: Active member can access tenant
  // =========================================================================
  it('should allow active MEMBER to access tenant', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, TenantRole.MEMBER);

    const res = await request(app.getHttpServer())
      .get('/test/tenant-required')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  // =========================================================================
  // Test 5: Non-member denied access
  // =========================================================================
  it('should deny access to non-member', async () => {
    await request(app.getHttpServer())
      .get('/test/tenant-required')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  // =========================================================================
  // Test 6: Suspended member denied
  // =========================================================================
  it('should deny access to suspended member', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, TenantRole.MEMBER);
    await tenantService.removeMember(TENANT_A, USER_ID);

    await request(app.getHttpServer())
      .get('/test/tenant-required')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  // =========================================================================
  // Test 7: MEMBER cannot access ADMIN endpoint
  // =========================================================================
  it('should deny MEMBER access to ADMIN-required endpoint', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, TenantRole.MEMBER);

    await request(app.getHttpServer())
      .get('/test/admin-required')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  // =========================================================================
  // Test 8: ADMIN can access ADMIN endpoint
  // =========================================================================
  it('should allow ADMIN to access ADMIN-required endpoint', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, TenantRole.ADMIN);

    const res = await request(app.getHttpServer())
      .get('/test/admin-required')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  // =========================================================================
  // Test 9: OWNER can access any role level
  // =========================================================================
  it('should allow OWNER to access any tenant endpoint', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, TenantRole.OWNER);

    await request(app.getHttpServer())
      .get('/test/tenant-required')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    await request(app.getHttpServer())
      .get('/test/admin-required')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    await request(app.getHttpServer())
      .get('/test/owner-required')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);
  });

  // =========================================================================
  // Test 10: System admin bypass (adminBypass: true)
  // =========================================================================
  it('should allow system admin to bypass membership check', async () => {
    // No membership created for admin user
    const res = await request(app.getHttpServer())
      .get('/test/tenant-required')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', ADMIN_USER_ID)
      .set('X-Test-User-Roles', RoleEnum.ADMIN)
      .expect(200);

    expect(res.body.tenantId).toBe(TENANT_A);
  });

  // =========================================================================
  // Test 11: Endpoint without @TenantRoles but with header → passes
  // =========================================================================
  it('should pass through endpoint without @TenantRoles even with header', async () => {
    const res = await request(app.getHttpServer())
      .get('/test/with-header-no-roles')
      .set('X-Tenant-Id', TENANT_A)
      .set('X-Test-User-Id', USER_ID)
      .expect(200);

    expect(res.body.ok).toBe(true);
    // Without @TenantRoles(), @CurrentTenant() should return undefined (no membership validation)
    expect(res.body.tenantId).toBeUndefined();
  });

  // =========================================================================
  // Test 12: Membership isolation between tenants
  // =========================================================================
  it('should deny access to tenant where user has no membership', async () => {
    await tenantService.addMember(TENANT_A, USER_ID, TenantRole.MEMBER);

    // Access tenant B where user has no membership
    await request(app.getHttpServer())
      .get('/test/tenant-required')
      .set('X-Tenant-Id', TENANT_B)
      .set('X-Test-User-Id', USER_ID)
      .expect(403);
  });

  // =========================================================================
  // Test 13: Role hierarchy values
  // =========================================================================
  it('should have correct role hierarchy', () => {
    expect(TENANT_ROLE_HIERARCHY[TenantRole.MEMBER]).toBeLessThan(TENANT_ROLE_HIERARCHY[TenantRole.ADMIN]);
    expect(TENANT_ROLE_HIERARCHY[TenantRole.ADMIN]).toBeLessThan(TENANT_ROLE_HIERARCHY[TenantRole.OWNER]);
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
    new ConfigService({ multiTenancy: {} } as any);

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
  it('should add a new member', async () => {
    const member = await tenantService.addMember(TENANT_A, USER_1, TenantRole.MEMBER);
    expect(member.user).toBe(USER_1);
    expect(member.tenant).toBe(TENANT_A);
    expect(member.role).toBe(TenantRole.MEMBER);
    expect(member.status).toBe(TenantMemberStatus.ACTIVE);
  });

  it('should reject duplicate active membership', async () => {
    await tenantService.addMember(TENANT_A, USER_1);
    await expect(tenantService.addMember(TENANT_A, USER_1)).rejects.toThrow('User is already an active member');
  });

  it('should reactivate suspended membership', async () => {
    await tenantService.addMember(TENANT_A, USER_1, TenantRole.MEMBER);
    // Need a second owner to allow removal
    await tenantService.addMember(TENANT_A, USER_2, TenantRole.OWNER);
    await tenantService.removeMember(TENANT_A, USER_1);

    const reactivated = await tenantService.addMember(TENANT_A, USER_1, TenantRole.ADMIN);
    expect(reactivated.status).toBe(TenantMemberStatus.ACTIVE);
    expect(reactivated.role).toBe(TenantRole.ADMIN);
  });

  // =========================================================================
  // removeMember
  // =========================================================================
  it('should suspend a member', async () => {
    await tenantService.addMember(TENANT_A, USER_1, TenantRole.MEMBER);
    const removed = await tenantService.removeMember(TENANT_A, USER_1);
    expect(removed.status).toBe(TenantMemberStatus.SUSPENDED);
  });

  it('should prevent removing the last owner', async () => {
    await tenantService.addMember(TENANT_A, USER_1, TenantRole.OWNER);
    await expect(tenantService.removeMember(TENANT_A, USER_1)).rejects.toThrow(
      'Cannot remove or demote the last owner',
    );
  });

  // =========================================================================
  // updateMemberRole
  // =========================================================================
  it('should update member role', async () => {
    await tenantService.addMember(TENANT_A, USER_1, TenantRole.MEMBER);
    const updated = await tenantService.updateMemberRole(TENANT_A, USER_1, TenantRole.ADMIN);
    expect(updated.role).toBe(TenantRole.ADMIN);
  });

  it('should prevent demoting the last owner', async () => {
    await tenantService.addMember(TENANT_A, USER_1, TenantRole.OWNER);
    await expect(tenantService.updateMemberRole(TENANT_A, USER_1, TenantRole.MEMBER)).rejects.toThrow(
      'Cannot remove or demote the last owner',
    );
  });

  // =========================================================================
  // findMemberships
  // =========================================================================
  it('should find all active memberships for a user', async () => {
    await tenantService.addMember('tenant-1', USER_1, TenantRole.MEMBER);
    await tenantService.addMember('tenant-2', USER_1, TenantRole.ADMIN);

    const memberships = await tenantService.findMemberships(USER_1);
    expect(memberships).toHaveLength(2);
  });

  // =========================================================================
  // getMembership
  // =========================================================================
  it('should get a specific membership', async () => {
    await tenantService.addMember(TENANT_A, USER_1, TenantRole.MEMBER);
    const membership = await tenantService.getMembership(TENANT_A, USER_1);
    expect(membership).toBeTruthy();
    expect(membership.role).toBe(TenantRole.MEMBER);
  });

  it('should return null for non-existent membership', async () => {
    const membership = await tenantService.getMembership(TENANT_A, 'non-existent');
    expect(membership).toBeNull();
  });
});
