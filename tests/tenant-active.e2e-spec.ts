import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { InjectModel, MongooseModule, Prop, Schema, SchemaFactory, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Roles } from '../src/core/common/decorators/roles.decorator';
import { RoleEnum } from '../src/core/common/enums/role.enum';
import { mongooseTenantPlugin } from '../src/core/common/plugins/mongoose-tenant.plugin';
import { ConfigService } from '../src/core/common/services/config.service';
import { IRequestContext, RequestContext } from '../src/core/common/services/request-context.service';
import { ApiTokenScopes } from '../src/core/modules/api-token/core-api-token.decorators';
import { createTenantApiTokenPrincipal } from '../src/core/modules/api-token/core-api-token.helpers';
import { CoreTenantMemberModel } from '../src/core/modules/tenant/core-tenant-member.model';
import { CurrentTenant } from '../src/core/modules/tenant/core-tenant.decorators';
import { DefaultHR, TenantMemberStatus } from '../src/core/modules/tenant/core-tenant.enums';
import { CoreTenantGuard } from '../src/core/modules/tenant/core-tenant.guard';
import { deriveTestDbUri } from './db-lifecycle.reporter';

/**
 * A switched-off tenant stays switched off — `multiTenancy.isTenantActive`.
 *
 * `CoreTenantGuard` validated the MEMBERSHIP and nothing else, so a tenant a project had deactivated
 * kept working for every member, every API token and every request without a tenant header (whose
 * tenant list still contained it). A project had to add its own guard, and still missed the
 * header-less path, where the plugin filters by the user's tenant list.
 *
 * With the hook configured, the guard asks it after the membership check, on every path that
 * establishes a tenant: 403 on the header paths and for tenant tokens, no enrichment on public routes,
 * and the tenant dropped from the user's tenant list. A platform administrator under `adminBypass`
 * still reaches the tenant — somebody has to be able to look into it and switch it back on.
 *
 * @regression   11.42.0 — a deactivated tenant kept working: the tenant guard checked the membership
 *   only.
 * @seen-failing Make `isTenantActive()` in src/core/modules/tenant/core-tenant.guard.ts always answer
 *   true — registered as mutation `tenant-active-hook-ignored` in tests/regression-mutations.json.
 */

@Schema({ timestamps: true })
class TenantMember extends CoreTenantMemberModel {}
const TenantMemberSchema = SchemaFactory.createForClass(TenantMember);

@Schema({ timestamps: true })
class ActiveItem {
  @Prop({ type: String })
  tenantId: string;

  @Prop({ required: true, type: String })
  name: string;
}
const ActiveItemSchema = SchemaFactory.createForClass(ActiveItem);

@Controller('active')
class ActiveTestController {
  constructor(@InjectModel(ActiveItem.name) private readonly itemModel: Model<ActiveItem>) {}

  @Get('member')
  @Roles(DefaultHR.MEMBER)
  member(@CurrentTenant() tenantId: string) {
    return { tenantId };
  }

  @Get('signed-in')
  @Roles(RoleEnum.S_USER)
  signedIn(@CurrentTenant() tenantId: string) {
    return { tenantId };
  }

  @Get('public')
  @Roles(RoleEnum.S_EVERYONE)
  publicRoute(@CurrentTenant() tenantId: string) {
    return { tenantId: tenantId ?? null };
  }

  /** No @Roles: without a header the guard scopes the plugin to the user's tenant list. */
  @Get('items')
  async items() {
    const items = await this.itemModel.find().lean().exec();
    return items.map((item) => item.name).sort();
  }

  @Get('token')
  @Roles(DefaultHR.MEMBER)
  @ApiTokenScopes('items:read')
  token(@CurrentTenant() tenantId: string) {
    return { tenantId };
  }
}

const TEST_DB_URI = deriveTestDbUri('tenant-active');

@Module({
  controllers: [ActiveTestController],
  imports: [
    MongooseModule.forRoot(TEST_DB_URI, {
      connectionFactory: (connection) => {
        connection.plugin(mongooseTenantPlugin);
        return connection;
      },
    }),
    MongooseModule.forFeature([
      { name: 'TenantMember', schema: TenantMemberSchema },
      { name: ActiveItem.name, schema: ActiveItemSchema },
    ]),
  ],
  providers: [CoreTenantGuard, { provide: APP_GUARD, useExisting: CoreTenantGuard }],
})
class ActiveTestModule {}

/** Sets req.user from test headers and opens a RequestContext, as the real middleware does. */
function authMiddleware() {
  return (req: any, _res: unknown, next: () => void) => {
    const tokenTenant = req.headers['x-test-tenant-token'] as string | undefined;
    const userId = req.headers['x-test-user-id'] as string | undefined;
    const roles = ((req.headers['x-test-user-roles'] as string) || '').split(',').filter(Boolean);
    if (tokenTenant) {
      req.user = createTenantApiTokenPrincipal({
        name: 'test token',
        publicId: 'pub',
        scopes: ['items:read'],
        tenantId: tokenTenant,
        tokenId: 'token-1',
      });
    } else if (userId) {
      req.user = { hasRole: (r: string[]) => r.some((x) => roles.includes(x)), id: userId, roles };
    }
    const context: IRequestContext = {
      get currentUser() {
        return req.user;
      },
      fromRequest: true,
      get isAdminBypass() {
        return req.isAdminBypass ?? false;
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
    };
    RequestContext.run(context, () => next());
  };
}

describe('multiTenancy.isTenantActive (e2e)', () => {
  let app: import('@nestjs/common').INestApplication;
  let guard: CoreTenantGuard;
  let memberModel: Model<TenantMember>;
  let itemModel: Model<ActiveItem>;
  let previousConfig: unknown;

  const ON = 'tenant-on';
  const OFF = 'tenant-off';
  const USER = 'user-1';
  const inactive = new Set<string>([OFF]);
  const hookCalls: string[] = [];

  const configure = (withHook: boolean, extra: Record<string, unknown> = {}) =>
    ConfigService.setConfig(
      {
        ...(previousConfig as object),
        apiTokens: { scopes: ['items:read'] },
        multiTenancy: {
          ...(withHook
            ? {
                isTenantActive: (tenantId: string) => {
                  hookCalls.push(tenantId);
                  return !inactive.has(tenantId);
                },
              }
            : {}),
          ...extra,
        },
      } as any,
      { reInit: true },
    );

  const get = (path: string, headers: Record<string, string> = {}) => {
    const call = request(app.getHttpServer()).get(path);
    for (const [key, value] of Object.entries(headers)) {
      call.set(key, value);
    }
    return call;
  };

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly;
    configure(true);
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [ActiveTestModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.use(authMiddleware());
    await app.init();
    guard = moduleFixture.get(CoreTenantGuard);
    memberModel = moduleFixture.get(getModelToken('TenantMember'));
    itemModel = moduleFixture.get(getModelToken(ActiveItem.name));
  });

  beforeEach(async () => {
    configure(true);
    hookCalls.length = 0;
    await RequestContext.runWithBypassTenantGuard(async () => {
      await memberModel.deleteMany({});
      await itemModel.deleteMany({});
      await memberModel.insertMany([
        { role: 'member', status: TenantMemberStatus.ACTIVE, tenant: ON, user: USER },
        { role: 'member', status: TenantMemberStatus.ACTIVE, tenant: OFF, user: USER },
      ]);
      await itemModel.insertMany([
        { name: 'on-item', tenantId: ON },
        { name: 'off-item', tenantId: OFF },
      ]);
    });
  });

  afterEach(() => {
    guard?.invalidateAll();
  });

  afterAll(async () => {
    await RequestContext.runWithBypassTenantGuard(async () => {
      await memberModel?.deleteMany({});
      await itemModel?.deleteMany({});
    });
    await app?.close();
    ConfigService.setConfig((previousConfig ?? {}) as any, { reInit: true });
  });

  describe('header paths', () => {
    it('refuses a member of a deactivated tenant on a tenant-role route', async () => {
      await get('/active/member', { 'x-tenant-id': OFF, 'x-test-user-id': USER }).expect(403);
    });

    it('refuses a member of a deactivated tenant on a signed-in route naming it', async () => {
      await get('/active/signed-in', { 'x-tenant-id': OFF, 'x-test-user-id': USER }).expect(403);
    });

    it('paired control: the same member passes in an active tenant', async () => {
      const response = await get('/active/member', { 'x-tenant-id': ON, 'x-test-user-id': USER }).expect(200);
      expect(response.body.tenantId).toBe(ON);
    });

    it('asks after the membership, so a non-member learns nothing about the tenant', async () => {
      await get('/active/member', { 'x-tenant-id': OFF, 'x-test-user-id': 'stranger' }).expect(403);
      expect(hookCalls).not.toContain(OFF);
    });

    it('does not block a public route, but sets no tenant context for a deactivated tenant', async () => {
      const response = await get('/active/public', { 'x-tenant-id': OFF, 'x-test-user-id': USER }).expect(200);
      expect(response.body.tenantId).toBeNull();
    });

    it('lets a platform administrator under adminBypass into a deactivated tenant', async () => {
      const response = await get('/active/member', {
        'x-tenant-id': OFF,
        'x-test-user-id': 'admin-1',
        'x-test-user-roles': RoleEnum.ADMIN,
      }).expect(200);
      expect(response.body.tenantId).toBe(OFF);
    });
  });

  describe('without a tenant header', () => {
    it("drops a deactivated tenant from the user's tenant list, so its data stays out of reach", async () => {
      const response = await get('/active/items', { 'x-test-user-id': USER }).expect(200);
      expect(response.body).toEqual(['on-item']);
    });
  });

  describe('tenant API tokens', () => {
    it('refuses a token of a deactivated tenant', async () => {
      await get('/active/token', { 'x-test-tenant-token': OFF }).expect(403);
    });

    it('paired control: a token of an active tenant passes', async () => {
      const response = await get('/active/token', { 'x-test-tenant-token': ON }).expect(200);
      expect(response.body.tenantId).toBe(ON);
    });
  });

  describe('WebSocket tenant resolution', () => {
    it('resolves no tenant for a deactivated one', async () => {
      expect(await guard.resolveTenantContext({ id: USER, roles: [] }, OFF)).toEqual({});
      expect(await guard.resolveTenantContext({ id: USER, roles: [] }, ON)).toMatchObject({ tenantId: ON });
    });
  });

  describe('paired controls without the hook', () => {
    it('keeps every tenant usable, as before', async () => {
      configure(false);
      await get('/active/member', { 'x-tenant-id': OFF, 'x-test-user-id': USER }).expect(200);
      const items = await get('/active/items', { 'x-test-user-id': USER }).expect(200);
      expect(items.body).toEqual(['off-item', 'on-item']);
    });
  });
});
