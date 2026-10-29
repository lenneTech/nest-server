import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Module, Param, Post, Req } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect } from 'vitest';

import {
  ApiTokenScopes,
  ComparisonOperatorEnum,
  CoreApiTokenService,
  CoreBetterAuthModule,
  CoreBetterAuthService,
  CoreModule,
  CorePersistenceModule,
  CoreTenantGuard,
  CoreTenantService,
  CurrentTenant,
  CurrentUser,
  DefaultHR,
  getApiTokenContext,
  type DataStore,
  HttpExceptionLogFilter,
  MongoStateStore,
  RoleEnum,
  Roles,
  SqlStateStore,
  TestGraphQLType,
  TestHelper,
} from '../src';
import envConfig from '../src/config.env';
import { SortOrderEnum } from '../src/core/common/enums/sort-order.emum';
import { getStoreToken } from '../src/core/common/persistence/persistence.tokens';
import { Any } from '../src/core/common/scalars/any.scalar';
import { DateScalar } from '../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../src/core/common/scalars/json.scalar';
import { CoreAuthService } from '../src/core/modules/auth/services/core-auth.service';
import { CronJobs } from '../src/server/common/services/cron-jobs.service';
import { AuthController } from '../src/server/modules/auth/auth.controller';
import { AuthModule } from '../src/server/modules/auth/auth.module';
import { BetterAuthModule } from '../src/server/modules/better-auth/better-auth.module';
import { FileModule } from '../src/server/modules/file/file.module';
import { ServerController } from '../src/server/server.controller';
import { deriveTestDbUri } from './db-lifecycle.reporter';
import { API_TOKEN_TEST_ENCRYPTION_KEY } from './helpers/api-token-e2e.helpers';
import { CORE_MODULE_DRIVERS, CoreModuleDriver, moduleIt } from './helpers/core-module-matrix';
import { createMysqlTestDatabase, type MysqlTestDatabase } from './helpers/mysql-test-db';
import { createPostgresTestDatabase, type PostgresTestDatabase } from './helpers/postgres-test-db';

/**
 * Executor of the core module parity matrix (`tests/helpers/core-module-matrix.ts`): the framework's modules,
 * assembled like the reference server, answering through REST and GraphQL — once with MongoDB as the only database,
 * once with PostgreSQL as the default source (MongoDB stays for what moves to SQL in later phases: Better-Auth, files).
 * Every case uses its own accounts, so a case can run alone.
 */
const PASSWORD = 'Parity-Password-1!';

/** The project's own tenant model: what `multiTenancy.isTenantActive` looks up through `store()` */
const ParityTenantSchema = new mongoose.Schema({ active: Boolean, name: String });

/** Routes released to API tokens, and one that is not — what the token cases call */
@Controller('parity-token')
class ParityTokenProbeController {
  @ApiTokenScopes('read')
  @Get('whoami')
  @Roles(RoleEnum.S_USER)
  whoami(@CurrentUser() user: any) {
    return { kind: getApiTokenContext(user)?.kind ?? null, userId: user?.id ?? null };
  }

  @Get('unreleased')
  @Roles(RoleEnum.S_USER)
  unreleased() {
    return { ok: true };
  }

  @ApiTokenScopes('read')
  @Get('platform-admin')
  @Roles(RoleEnum.ADMIN)
  platformAdmin() {
    return { ok: true };
  }

  @ApiTokenScopes('read')
  @Get('member')
  @Roles(DefaultHR.MEMBER)
  member(@Req() req: any) {
    return { tenantId: req.tenantId ?? null };
  }
}

/** Token management, written the way a project writes it: forward, let the service decide */
@Controller('parity-api-tokens')
@Roles(RoleEnum.S_USER)
class ParityTokenAdminController {
  constructor(private readonly apiTokens: CoreApiTokenService) {}

  @Post('mine')
  createMine(@Body() body: any, @CurrentUser() user: any) {
    return this.apiTokens.createUserToken(body, user);
  }

  @Get('mine')
  listMine(@CurrentUser() user: any) {
    return this.apiTokens.findUserTokens(user);
  }

  @HttpCode(HttpStatus.OK)
  @Post('mine/:id/revoke')
  revokeMine(@Param('id') id: string, @CurrentUser() user: any) {
    return this.apiTokens.revokeUserToken(id, user);
  }

  @Post('tenant')
  createTenant(@CurrentTenant() tenantId: string, @Body() body: any, @CurrentUser() user: any) {
    return this.apiTokens.createTenantToken(tenantId, body, user);
  }

  @Delete('tenant/:id')
  deleteTenant(@CurrentTenant() tenantId: string, @Param('id') id: string, @CurrentUser() user: any) {
    return this.apiTokens.deleteTenantToken(tenantId, id, user);
  }
}

/** Routes a project guards with tenant roles — what the tenant cases call */
@Controller('parity-tenant')
class ParityTenantController {
  @Get('member')
  @Roles(DefaultHR.MEMBER)
  member(@Req() req: any) {
    return { tenantId: req.tenantId ?? null, tenantRole: req.tenantRole ?? null };
  }

  @Get('owner')
  @Roles(DefaultHR.OWNER)
  owner(@Req() req: any) {
    return { tenantId: req.tenantId ?? null };
  }

  /** No @Roles: an authenticated caller without a header works in all its tenants (CoreTenantGuard, "NO HEADER") */
  @Get('mine')
  mine(@Req() req: any) {
    return { tenantIds: [...(req.tenantIds ?? [])].sort() };
  }
}

interface Harness {
  app: any;
  betterAuth: CoreBetterAuthService;
  database?: MysqlTestDatabase | PostgresTestDatabase;
  moduleRef: TestingModule;
  apiTokens: DataStore<any>;
  tenantGuard: CoreTenantGuard;
  tenants: DataStore<any>;
  tenantService: CoreTenantService;
  testHelper: TestHelper;
  users: DataStore<any>;
}

async function boot(driver: CoreModuleDriver): Promise<Harness> {
  const database =
    driver === 'postgres'
      ? await createPostgresTestDatabase('module-parity')
      : driver === 'mongodb'
        ? undefined
        : await createMysqlTestDatabase(driver, 'module-parity');
  const config = {
    ...envConfig,
    auth: {
      ...envConfig.auth,
      legacyEndpoints: { enabled: true },
      // Every case signs in several times; the limit is a separate concern with its own suites
      rateLimit: { enabled: false },
    },
    // Users on SQL: Better-Auth beside the legacy endpoints, as on MongoDB — its adapter runs on every database
    ...(database ? { database: { ownerUrl: database.ownerUrl, url: database.appUrl } } : {}),
    mongoose: { ...envConfig.mongoose, uri: deriveTestDbUri(`module-parity-${driver}`) },
    apiTokens: { encryptionKey: API_TOKEN_TEST_ENCRYPTION_KEY, scopes: ['read', 'export'] },
    multiTenancy: {
      // The neutral lookup: the tenant model is stored wherever `database` routes it
      isTenantActive: async (tenantId: string, { store }: { store: (name: string) => DataStore<any> }) =>
        (await store('ParityTenant').findById(tenantId))?.active !== false,
    },
  };
  CoreBetterAuthModule.reset();

  @Module({
    controllers: [
      ServerController,
      AuthController,
      ParityTenantController,
      ParityTokenAdminController,
      ParityTokenProbeController,
    ],
    imports: [
      CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(config.jwt), config as any),
      CorePersistenceModule.forFeature([{ name: 'ParityTenant', schema: ParityTenantSchema }]),
      ScheduleModule.forRoot(),
      AuthModule.forRoot(config.jwt),
      BetterAuthModule.forRoot({}),
      FileModule,
    ],
    providers: [Any, CronJobs, DateScalar, JSONScalar, { provide: 'PUB_SUB', useValue: new PubSub() }],
  })
  class ParityServerModule {}

  const moduleRef = await Test.createTestingModule({ imports: [ParityServerModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new HttpExceptionLogFilter());
  (app as any).setBaseViewsDir(config.templates.path);
  (app as any).setViewEngine(config.templates.engine);
  await app.init();
  return {
    app,
    betterAuth: moduleRef.get(CoreBetterAuthService, { strict: false }),
    database,
    moduleRef,
    apiTokens: moduleRef.get(getStoreToken('ApiToken'), { strict: false }),
    tenantGuard: moduleRef.get(CoreTenantGuard, { strict: false }),
    tenants: moduleRef.get(getStoreToken('ParityTenant'), { strict: false }),
    tenantService: moduleRef.get(CoreTenantService, { strict: false }),
    testHelper: new TestHelper(app),
    users: moduleRef.get(getStoreToken('User'), { strict: false }),
  };
}

describe.each(CORE_MODULE_DRIVERS)('core module parity — %s (e2e)', (driver) => {
  let harness: Harness;
  let testHelper: TestHelper;
  let users: DataStore<any>;
  let adminToken: string;

  const unique = (label: string) =>
    `parity-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`.toLowerCase();

  /** The HTTP status a GraphQL error carries, `undefined` when the operation succeeded */
  const statusOf = (result: any) => result?.errors?.[0]?.extensions?.originalError?.statusCode;

  const gql = (name: string, args: Record<string, unknown>, fields: any[] | undefined, token?: string, query = false) =>
    testHelper.graphQl(
      { arguments: args, fields, name, type: query ? TestGraphQLType.QUERY : TestGraphQLType.MUTATION },
      token ? { token } : {},
    ) as Promise<any>;

  const signUp = (email: string, password = PASSWORD) =>
    gql('signUp', { input: { email, firstName: 'Parity', password } }, [
      'token',
      'refreshToken',
      { user: ['id', 'email', 'roles', 'createdBy'] },
    ]);

  const signIn = (email: string, password = PASSWORD) =>
    gql('signIn', { input: { email, password } }, ['token', 'refreshToken', { user: ['id', 'email'] }]);

  const refresh = (refreshToken: string) =>
    gql('refreshToken', {}, ['token', 'refreshToken', { user: ['id'] }], refreshToken);

  beforeAll(async () => {
    harness = await boot(driver);
    ({ testHelper, users } = harness);
    // The administrator exists before anyone signs up — seeded as system work, the way a migration seeds one
    const adminEmail = unique('admin');
    await users.insert({ email: adminEmail, password: PASSWORD, roles: ['admin'], verified: true });
    adminToken = (await signIn(adminEmail)).token;
  });

  afterAll(async () => {
    await harness?.app?.close();
    await harness?.database?.drop();
    CoreBetterAuthModule.reset();
  });

  // --- users and legacy sign-in --------------------------------------------------------------------------------

  moduleIt('user-sign-up', driver, async () => {
    const email = unique('sign-up');
    const created = await signUp(email);
    expect(created.user).toMatchObject({ email, roles: [] });
    expect(created.user.createdBy).toBe(created.user.id);
    expect(created.token.length).toBeGreaterThan(0);

    const again = await signUp(email, `${PASSWORD}2`);
    expect(statusOf(again)).toBe(400);
    expect(again.errors[0].message).toBe('Email address already in use');
  });

  moduleIt('user-email-normalized', driver, async () => {
    const email = unique('normalized');
    // Surrounding blanks are refused by the input validation before the setter could trim them
    const created = await signUp(email.toUpperCase());
    expect(created.user.email).toBe(email);
    expect((await users.findById(created.user.id)).email).toBe(email);
    // The same normalisation applies to the address a sign-in looks up
    expect((await signIn(email.toUpperCase())).user?.id).toBe(created.user.id);
  });

  moduleIt('user-sign-in', driver, async () => {
    const email = unique('sign-in');
    const { user } = await signUp(email);
    const signedIn = await signIn(email);
    expect(signedIn.user.id).toBe(user.id);
    expect(signedIn.token.length).toBeGreaterThan(0);
    expect(signedIn.refreshToken.length).toBeGreaterThan(0);
    expect(statusOf(await signIn(email, 'Wrong-Password-1!'))).toBe(401);
    expect(statusOf(await signIn(unique('nobody')))).toBe(401);
  });

  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — a legacy logout deleted the device from `refreshTokens` and wrote
   *   the map through `update()`, which MERGES the input into the stored record: the deleted key survived, and the
   *   logged-out device's refresh token kept working (on MongoDB since long before; found by this matrix).
   * @seen-failing Write `{ refreshTokens: user.refreshTokens }` (the map with the key deleted) again in
   *   CoreAuthService.logout() in src/core/modules/auth/services/core-auth.service.ts — registered as mutation
   *   `legacy-logout-keeps-refresh-token` in tests/regression-mutations.json.
   */
  moduleIt('user-refresh-and-logout', driver, async () => {
    const email = unique('refresh');
    const session = await signUp(email);
    expect(statusOf(await refresh(session.token))).toBe(401);

    const renewed = await refresh(session.refreshToken);
    expect(renewed.user.id).toBe(session.user.id);
    expect(renewed.token.length).toBeGreaterThan(0);

    // Two more devices
    const second = await signIn(email);
    const third = await signIn(email);

    expect(await gql('logout', {}, undefined, renewed.token)).toBe(true);
    expect(statusOf(await refresh(renewed.refreshToken))).toBe(401);
    // ... and only that device
    const secondRenewed = await refresh(second.refreshToken);
    expect(secondRenewed.user?.id).toBe(session.user.id);

    expect(await gql('logout', { allDevices: true }, undefined, secondRenewed.token)).toBe(true);
    expect(statusOf(await refresh(secondRenewed.refreshToken))).toBe(401);
    expect(statusOf(await refresh(third.refreshToken))).toBe(401);
  });

  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — with the user model routed to PostgreSQL, CoreUserService still
   *   looked users up through the Mongoose model (verification, reset, sign-in by address), i.e. in the wrong database.
   * @seen-failing Drop the data-store branch of CoreUserService.findStoredUser() in
   *   src/core/modules/user/core-user.service.ts — registered as mutation `user-service-reads-mongo-on-sql` in
   *   tests/regression-mutations.json.
   */
  moduleIt('user-verify', driver, async () => {
    const { user } = await signUp(unique('verify'));
    const { verificationToken, verified } = await users.findById(user.id, {
      select: ['verificationToken', 'verified'],
    });
    expect(verified).toBeFalsy();
    expect(verificationToken).toMatch(/^[0-9a-f]{64}$/);

    expect(await gql('verifyUser', { token: verificationToken }, undefined)).toBe(true);
    expect((await users.findById(user.id)).verified).toBe(true);
    expect(await gql('getVerifiedState', { token: verificationToken }, undefined, undefined, true)).toBe(true);
  });

  moduleIt('user-password-reset', driver, async () => {
    const email = unique('reset');
    const session = await signUp(email);
    expect(await gql('requestPasswordResetMail', { email }, undefined)).toBe(true);
    const { passwordResetToken } = await users.findById(session.user.id, { select: ['passwordResetToken'] });
    expect(passwordResetToken).toMatch(/^[0-9a-f]{64}$/);

    const newPassword = 'Parity-New-Password-2!';
    expect(await gql('resetPassword', { password: newPassword, token: passwordResetToken }, undefined)).toBe(true);
    expect((await signIn(email, newPassword)).user?.id).toBe(session.user.id);
    expect(statusOf(await signIn(email))).toBe(401);
    // A reset ends the legacy sessions: the refresh token from before no longer works
    expect(statusOf(await refresh(session.refreshToken))).toBe(401);
    // And the token works once
    expect(statusOf(await gql('resetPassword', { password: PASSWORD, token: passwordResetToken }, undefined))).toBe(
      404,
    );
  });

  moduleIt('user-password-reset-expired', driver, async () => {
    const email = unique('reset-expired');
    const { user } = await signUp(email);
    expect(await gql('requestPasswordResetMail', { email }, undefined)).toBe(true);
    const { passwordResetToken } = await users.findById(user.id, { select: ['passwordResetToken'] });
    await users.updateById(user.id, { passwordResetTokenExpiresAt: new Date(Date.now() - 60_000) });

    expect(
      statusOf(await gql('resetPassword', { password: 'Other-Password-3!', token: passwordResetToken }, undefined)),
    ).toBe(404);
    // Burnt on sight
    const stored = await users.findById(user.id, { select: ['passwordResetToken', 'passwordResetTokenExpiresAt'] });
    expect(stored.passwordResetToken ?? null).toBeNull();
    expect(stored.passwordResetTokenExpiresAt ?? null).toBeNull();
    expect((await signIn(email)).user?.id).toBe(user.id);
  });

  moduleIt('user-update-self', driver, async () => {
    const email = unique('update-self');
    const a = await signUp(email);
    const b = await signUp(unique('update-other'));

    const renamed = await gql(
      'updateUser',
      { id: a.user.id, input: { firstName: 'Renamed' } },
      ['id', 'firstName'],
      a.token,
    );
    expect(renamed).toMatchObject({ firstName: 'Renamed', id: a.user.id });
    expect((await users.findById(a.user.id)).firstName).toBe('Renamed');

    const newPassword = 'Parity-Changed-Password-4!';
    expect((await gql('updateUser', { id: a.user.id, input: { password: newPassword } }, ['id'], a.token)).id).toBe(
      a.user.id,
    );
    expect((await signIn(email, newPassword)).user?.id).toBe(a.user.id);
    expect(statusOf(await signIn(email))).toBe(401);

    expect(
      statusOf(await gql('updateUser', { id: b.user.id, input: { firstName: 'Hijacked' } }, ['id'], a.token)),
    ).toBe(403);
    expect((await users.findById(b.user.id)).firstName).toBe('Parity');
  });

  moduleIt('user-roles', driver, async () => {
    const member = await signUp(unique('roles'));
    const promoted = await gql(
      'updateUser',
      { id: member.user.id, input: { roles: ['editor'] } },
      ['id', 'roles'],
      adminToken,
    );
    expect(promoted.roles).toEqual(['editor']);
    expect((await users.findById(member.user.id)).roles).toEqual(['editor']);

    // A user cannot grant themselves a role
    await gql('updateUser', { id: member.user.id, input: { roles: ['admin'] } }, ['id', 'roles'], member.token);
    expect((await users.findById(member.user.id)).roles).toEqual(['editor']);

    // A system role is refused for everyone, administrators included — by the input validation
    const refused = await gql('updateUser', { id: member.user.id, input: { roles: ['s_self'] } }, ['id'], adminToken);
    expect(refused.errors?.[0]?.message).toMatch(/Validation failed .*roles/);
    expect((await users.findById(member.user.id)).roles).toEqual(['editor']);
  });

  moduleIt('user-find-and-count', driver, async () => {
    const marker = `findcount${Date.now()}`;
    const emails = ['b', 'a', 'c'].map((letter) => `${marker}-${letter}@test.com`);
    for (const email of emails) {
      await signUp(email);
    }
    const page = await gql(
      'findAndCountUsers',
      {
        filter: { singleFilter: { field: 'email', operator: ComparisonOperatorEnum.REGEX, value: `^${marker}-` } },
        limit: 1,
        skip: 1,
        sort: [{ field: 'email', order: SortOrderEnum.ASC }],
      },
      [{ items: ['email'] }, 'totalCount'],
      adminToken,
      true,
    );
    expect(page.totalCount).toBe(3);
    expect(page.items.map((user: any) => user.email)).toEqual([`${marker}-b@test.com`]);

    const member = await signUp(unique('find-member'));
    expect(statusOf(await gql('findAndCountUsers', {}, [{ items: ['id'] }, 'totalCount'], member.token, true))).toBe(
      403,
    );
  });

  moduleIt('user-delete', driver, async () => {
    const email = unique('delete');
    const { user } = await signUp(email);
    expect((await gql('deleteUser', { id: user.id }, ['id'], adminToken)).id).toBe(user.id);
    expect(await users.findById(user.id)).toBeNull();
    expect(statusOf(await signIn(email))).toBe(401);
  });

  // --- IAM (Better-Auth) ---------------------------------------------------------------------------------------

  /**
   * An IAM sign-up and sign-in; answers the user's id, the token the sign-in hands out (a JWT here) and the session's
   * own token as Better-Auth stores it
   */
  const iamSignUp = async (email: string, extra: Record<string, unknown> = {}) => {
    const created = await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: 'Parity Iam', password: PASSWORD, termsAndPrivacyAccepted: true, ...extra },
      statusCode: 201,
    });
    const signedIn = await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email, password: PASSWORD },
      statusCode: 200,
    });
    const id = String(created.user.id);
    const sessionToken = (await harness.betterAuth.getActiveSessionForUser(id)).session?.token;
    return { id, sessionToken: String(sessionToken ?? ''), token: String(signedIn.token) };
  };

  moduleIt('iam-sign-up-and-sign-in', driver, async () => {
    const email = unique('iam-sign-in');
    const { id, sessionToken, token } = await iamSignUp(email);
    // One user, the one the user model reads — with the framework's fields beside Better-Auth's
    expect(await users.count({ email } as any)).toBe(1);
    expect(await users.findById(id)).toMatchObject({ email, roles: [] });
    // The session resolves to the user, and the token the sign-in handed out authenticates them (403 on an
    // administrator's route, not 401)
    expect((await harness.betterAuth.getSessionByToken(sessionToken)).user).toMatchObject({ email, id });
    expect(statusOf(await gql('findUsers', {}, ['id'], token, true))).toBe(403);

    await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email, password: 'Wrong-Password-1!' },
      statusCode: 401,
    });
  });

  /**
   * @regression   DEV-3904 — Better-Auth's update-user route takes any field its schema declares as input; `roles` is
   *   kept out only by `input: false`, which `buildUserFields()` re-asserts after a project's fields are merged. Pinned
   *   on every database the adapter now runs on, MySQL and MariaDB included.
   * @seen-failing Re-assert `input: true` for `roles` in buildUserFields() in
   *   src/core/modules/better-auth/better-auth.config.ts — registered as mutation `iam-roles-input-reopened` in
   *   tests/regression-mutations.json.
   */
  moduleIt('iam-roles-not-input', driver, async () => {
    const email = unique('iam-roles');
    const { id, token } = await iamSignUp(email, { roles: ['admin'] });
    expect((await users.findById(id)).roles).toEqual([]);

    await testHelper.rest('/iam/update-user', { method: 'POST', payload: { roles: ['admin'] }, statusCode: 400, token });
    expect((await users.findById(id)).roles).toEqual([]);
    // An administrator's route stays closed to the user
    expect(statusOf(await gql('findUsers', {}, ['id'], token, true))).toBe(403);
  });

  /**
   * @regression   DEV-3904 — the framework installs the password hashing Better-Auth uses (`nativeScryptHash`); on
   *   every database the credential must hold its hash, never the password.
   * @seen-failing Hand Better-Auth a hash / verify pair that stores and compares the password in clear in
   *   better-auth.config.ts (sign-in keeps working) — registered as mutation `iam-password-stored-plain` in
   *   tests/regression-mutations.json.
   */
  moduleIt('iam-password-hashed', driver, async () => {
    const email = unique('iam-hash');
    const { id } = await iamSignUp(email);
    const context = await (harness.betterAuth.getInstance() as any).$context;
    const credential = await context.internalAdapter.findCredentialAccount(id);
    // Better-Auth's `salt:key` scrypt format
    expect(credential?.password).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(credential.password).not.toContain(PASSWORD);
    // The legacy password the sign-up synchronised: a bcrypt hash
    const stored = await users.findById(id);
    expect(stored.password).toMatch(/^\$2[aby]\$/);
  });

  /**
   * @regression   DEV-3904 — `POST /iam/sign-out` is the framework's controller; it must end the session in Better-Auth's
   *   table, not only clear the cookies, or a captured token keeps working.
   * @seen-failing Skip revokeSession() in CoreBetterAuthController.signOut() in
   *   src/core/modules/better-auth/core-better-auth.controller.ts — registered as mutation `iam-sign-out-keeps-session`
   *   in tests/regression-mutations.json.
   */
  moduleIt('iam-session-revoked', driver, async () => {
    const email = unique('iam-sign-out');
    const { id, sessionToken } = await iamSignUp(email);
    expect((await harness.betterAuth.getSessionByToken(sessionToken)).user?.id).toBe(id);

    await testHelper.rest('/iam/sign-out', { method: 'POST', statusCode: 201, token: sessionToken });

    expect((await harness.betterAuth.getSessionByToken(sessionToken)).session).toBeFalsy();
  });

  // --- tenants -------------------------------------------------------------------------------------------------

  /** A tenant id as the project's tenant model would hand it out */
  const newTenant = async (active = true) => (await harness.tenants.insert({ active, name: 'Parity tenant' })).id;

  const member = async (label: string) => {
    const session = await signUp(unique(label));
    return { id: session.user.id as string, token: session.token as string };
  };

  const tenantRoute = (path: string, token: string, tenantId?: string, statusCode = 200) =>
    testHelper.rest(`/parity-tenant/${path}`, {
      headers: tenantId ? { 'x-tenant-id': tenantId } : {},
      statusCode,
      token,
    }) as Promise<any>;

  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — CoreModule registers the tenant module ahead of a project's
   *   AuthModule, so with legacy JWTs the tenant guard ran before the role guard had identified anybody and answered
   *   every tenant route with 401 (on MongoDB too; found by this matrix).
   * @seen-failing Skip identifyThroughRoleGuard() in CoreTenantGuard.canActivate() in
   *   src/core/modules/tenant/core-tenant.guard.ts — registered as mutation `tenant-guard-before-identification` in
   *   tests/regression-mutations.json.
   */
  moduleIt('tenant-member-access', driver, async () => {
    const [tenantA, tenantB] = [await newTenant(), await newTenant()];
    const alice = await member('tenant-alice');
    const bob = await member('tenant-bob');
    const outsider = await member('tenant-outsider');
    await harness.tenantService.addMember(tenantA, alice.id, 'member');
    await harness.tenantService.addMember(tenantB, bob.id, 'member');

    expect(await tenantRoute('member', alice.token, tenantA)).toEqual({ tenantId: tenantA, tenantRole: 'member' });
    await tenantRoute('member', outsider.token, tenantA, 403);
    await tenantRoute('member', bob.token, tenantA, 403);
  });

  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — with the membership model routed to PostgreSQL, the tenant guard
   *   and service kept reading and writing memberships through the Mongoose model, i.e. in the wrong database.
   * @seen-failing Make routedMemberStore() return undefined in src/core/modules/tenant/core-tenant-member.store.ts —
   *   registered as mutation `tenant-membership-on-mongo-on-sql` in tests/regression-mutations.json.
   */
  moduleIt('tenant-membership-lifecycle', driver, async () => {
    const tenant = await newTenant();
    const owner = await member('lifecycle-owner');
    const carol = await member('lifecycle-carol');
    await harness.tenantService.addMember(tenant, owner.id, 'owner');
    const first = await harness.tenantService.addMember(tenant, carol.id, 'member');
    await tenantRoute('member', carol.token, tenant);

    await harness.tenantService.removeMember(tenant, carol.id);
    await tenantRoute('member', carol.token, tenant, 403);
    expect((await harness.tenantService.getMembership(tenant, carol.id))?.status).toBe('SUSPENDED');
    expect(await harness.tenantService.getActiveMembership(tenant, carol.id)).toBeNull();

    const again = await harness.tenantService.addMember(tenant, carol.id, 'member');
    expect(String((again as any).id ?? (again as any)._id)).toBe(String((first as any).id ?? (first as any)._id));
    await tenantRoute('member', carol.token, tenant);
    expect((await harness.tenantService.findMemberships(carol.id)).map((membership) => membership.tenant)).toEqual([
      tenant,
    ]);
  });

  moduleIt('tenant-role-hierarchy', driver, async () => {
    const tenant = await newTenant();
    const owner = await member('hierarchy-owner');
    const dave = await member('hierarchy-dave');
    await harness.tenantService.addMember(tenant, owner.id, 'owner');
    await harness.tenantService.addMember(tenant, dave.id, 'member');

    expect(await tenantRoute('owner', owner.token, tenant)).toEqual({ tenantId: tenant });
    await tenantRoute('owner', dave.token, tenant, 403);
    // The owner route is reachable for the member route's role too: higher includes lower
    expect((await tenantRoute('member', owner.token, tenant)).tenantRole).toBe('owner');

    await harness.tenantService.updateMemberRole(tenant, dave.id, 'owner');
    expect(await tenantRoute('owner', dave.token, tenant)).toEqual({ tenantId: tenant });
  });

  moduleIt('tenant-last-owner', driver, async () => {
    const tenant = await newTenant();
    const owner = await member('last-owner');
    await harness.tenantService.addMember(tenant, owner.id, 'owner');
    await expect(harness.tenantService.removeMember(tenant, owner.id)).rejects.toThrow(/last owner/);
    await expect(harness.tenantService.updateMemberRole(tenant, owner.id, 'member')).rejects.toThrow(/last owner/);
    expect((await harness.tenantService.getActiveMembership(tenant, owner.id))?.role).toBe('owner');
  });

  moduleIt('tenant-ids-without-header', driver, async () => {
    const [one, two, left] = [await newTenant(), await newTenant(), await newTenant()];
    const erin = await member('ids-erin');
    await harness.tenantService.addMember(one, erin.id, 'member');
    await harness.tenantService.addMember(two, erin.id, 'manager');
    await harness.tenantService.addMember(left, erin.id, 'owner');
    const ownerOfLeft = await member('ids-owner');
    await harness.tenantService.addMember(left, ownerOfLeft.id, 'owner');
    await harness.tenantService.removeMember(left, erin.id);

    expect((await tenantRoute('mine', erin.token)).tenantIds).toEqual([one, two].sort());
  });

  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — `isTenantActive` received only the MongoDB connection, which
   *   cannot reach a tenant model stored in PostgreSQL: every tenant counted as active there.
   * @seen-failing Pass `store: () => undefined` to the hook in CoreTenantGuard.isTenantActive() in
   *   src/core/modules/tenant/core-tenant.guard.ts — registered as mutation `tenant-active-hook-without-store` in
   *   tests/regression-mutations.json.
   */
  moduleIt('tenant-inactive', driver, async () => {
    const tenant = await newTenant();
    const frank = await member('inactive-frank');
    await harness.tenantService.addMember(tenant, frank.id, 'member');
    await tenantRoute('member', frank.token, tenant);

    await harness.tenants.updateById(tenant, { active: false });
    harness.tenantGuard.invalidateTenant(tenant);
    await tenantRoute('member', frank.token, tenant, 403);
    expect((await tenantRoute('mine', frank.token)).tenantIds).toEqual([]);
  });
  // --- API tokens ----------------------------------------------------------------------------------------------

  const withToken = (path: string, token: string, statusCode = 200, tenantId?: string) =>
    testHelper.rest(path, {
      headers: { authorization: `Bearer ${token}`, ...(tenantId ? { 'x-tenant-id': tenantId } : {}) },
      statusCode,
    }) as Promise<any>;

  const createUserToken = (session: { token: string }, body: Record<string, unknown> = {}) =>
    testHelper.rest('/parity-api-tokens/mine', {
      method: 'POST',
      payload: { name: 'parity', scopes: ['read'], ...body },
      statusCode: 201,
      token: session.token,
    }) as Promise<any>;

  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — with the users in PostgreSQL, a user token's owner was loaded from
   *   the MongoDB `users` collection, found nobody, and every user token answered 401.
   * @seen-failing Make CoreApiTokenService.userStore() resolve nothing in
   *   src/core/modules/api-token/core-api-token.service.ts — registered as mutation `api-token-owner-from-mongo-on-sql`
   *   in tests/regression-mutations.json.
   */
  moduleIt('api-token-user-lifecycle', driver, async () => {
    const owner = await member('token-owner');
    const created = await createUserToken(owner);
    expect(created.token).toMatch(/^ltt_/);
    expect(created.apiToken).not.toHaveProperty('secretHash');

    expect(await withToken('/parity-token/whoami', created.token)).toEqual({ kind: 'user', userId: owner.id });
    await withToken('/parity-token/unreleased', created.token, 403);

    const listed = await testHelper.rest('/parity-api-tokens/mine', { token: owner.token });
    expect(listed.map((token: any) => token.id)).toEqual([created.apiToken.id]);

    const revoked = await testHelper.rest(`/parity-api-tokens/mine/${created.apiToken.id}/revoke`, {
      method: 'POST',
      token: owner.token,
    });
    expect(revoked.revokedAt).toBeTruthy();
    await withToken('/parity-token/whoami', created.token, 401);
  });

  moduleIt('api-token-no-global-roles', driver, async () => {
    const created = await createUserToken({ token: adminToken });
    expect((await withToken('/parity-token/whoami', created.token)).kind).toBe('user');
    await withToken('/parity-token/platform-admin', created.token, 403);
    // The administrator's own session keeps its rights
    expect(await testHelper.rest('/parity-token/platform-admin', { token: adminToken })).toEqual({ ok: true });
  });

  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — with the token model routed to PostgreSQL, the service kept issuing
   *   and looking up tokens through the Mongoose model.
   * @seen-failing Make the CoreApiTokenService.tokenStore getter return undefined in
   *   src/core/modules/api-token/core-api-token.service.ts — registered as mutation `api-token-store-on-mongo-on-sql` in
   *   tests/regression-mutations.json.
   */
  moduleIt('api-token-tenant-token', driver, async () => {
    const [own, other] = [await newTenant(), await newTenant()];
    const owner = await member('tenant-token-owner');
    await harness.tenantService.addMember(own, owner.id, 'owner');

    const created = await testHelper.rest('/parity-api-tokens/tenant', {
      headers: { 'x-tenant-id': own },
      method: 'POST',
      payload: { name: 'integration', scopes: ['read'] },
      statusCode: 201,
      token: owner.token,
    });
    expect(await withToken('/parity-token/member', created.token)).toEqual({ tenantId: own });
    await withToken('/parity-token/member', created.token, 403, other);

    await testHelper.rest(`/parity-api-tokens/tenant/${created.apiToken.id}`, {
      headers: { 'x-tenant-id': own },
      method: 'DELETE',
      token: owner.token,
    });
    await withToken('/parity-token/member', created.token, 401);
  });

  moduleIt('api-token-revoked-on-password-reset', driver, async () => {
    const email = unique('token-reset');
    const session = await signUp(email);
    const created = await createUserToken(session);
    await withToken('/parity-token/whoami', created.token);

    expect(await gql('requestPasswordResetMail', { email }, undefined)).toBe(true);
    const { passwordResetToken } = await users.findById(session.user.id, { select: ['passwordResetToken'] });
    expect(
      await gql('resetPassword', { password: 'Parity-Reset-Token-5!', token: passwordResetToken }, undefined),
    ).toBe(true);
    await withToken('/parity-token/whoami', created.token, 401);
  });

  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — the SQL store stamped `updatedAt` on every update, so a token's
   *   update time moved with every use, where MongoDB writes the stamp with `timestamps: false`.
   * @seen-failing Ignore `options.timestamps` in SqlDataStore.beforeUpdate() in
   *   src/core/common/persistence/sql/sql-data-store.ts — registered as mutation `sql-update-ignores-timestamps-false`
   *   in tests/regression-mutations.json.
   */
  moduleIt('api-token-last-used', driver, async () => {
    const owner = await member('token-last-used');
    const created = await createUserToken(owner);
    const before = await harness.apiTokens.findById(created.apiToken.id);
    expect(before.lastUsedAt ?? null).toBeNull();

    await withToken('/parity-token/whoami', created.token);
    // The stamp is written after the response, without being awaited
    let after: any;
    for (let attempt = 0; attempt < 50 && !after?.lastUsedAt; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      after = await harness.apiTokens.findById(created.apiToken.id);
    }
    expect(after.lastUsedAt).toBeInstanceOf(Date);
    expect(new Date(after.updatedAt).getTime()).toBe(new Date(before.updatedAt).getTime());
  });
  // --- operations ----------------------------------------------------------------------------------------------

  moduleIt('health-check-every-database', driver, async () => {
    const result = await testHelper.rest('/health-check');
    expect(result.status).toBe('ok');
    expect(result.info.database.status).toBe('up');
    const sqlKeys = Object.keys(result.info).filter((key) => key.startsWith('database:'));
    expect(sqlKeys).toEqual(driver === 'mongodb' ? [] : ['database:default']);
    for (const key of sqlKeys) {
      expect(result.info[key].status).toBe('up');
    }
  });
  moduleIt('hub-persistence-panel', driver, async () => {
    const panel = await testHelper.rest('/hub/persistence.json', { token: adminToken });
    const database = driver;
    const defaultSource = panel.sources.find((source: any) => source.name === panel.defaultSource);
    expect(defaultSource).toMatchObject({ driver: database, name: 'default' });
    expect(JSON.stringify(panel.sources)).not.toMatch(/@/);
    const user = panel.models.find((model: any) => model.name === 'User');
    expect(user).toMatchObject({ driver: database, source: 'default' });
    expect(user.capabilities).toContain(driver === 'mongodb' ? 'mongoosePopulate' : 'transactions');
    // Row-level security is PostgreSQL's alone; on MySQL / MariaDB the panel must not claim it
    expect(user.capabilities.includes('rls')).toBe(driver === 'postgres');
    await testHelper.rest('/hub/persistence.json', { statusCode: 403, token: (await member('hub-member')).token });
  });

  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — with the migration state on PostgreSQL, the Hub read the MongoDB
   *   migrations collection and showed a project that had run every migration as one that never ran any. The other
   *   way round, a project whose migrations-utils/migrate.js still writes MongoDB found its applied migrations listed
   *   as pending in the empty table, one "Run" away from applying them all again.
   * @seen-failing Make CoreHubMigrationsService.sqlStateStore() return undefined, or migrationStateLeftInMongo()
   *   answer false, in src/core/modules/hub/services/core-hub-migrations.service.ts — registered as mutations
   *   `hub-migrations-read-mongo-on-sql` and `hub-migrations-ignore-state-left-in-mongo` in
   *   tests/regression-mutations.json.
   */
  moduleIt('hub-migrations-panel', driver, async () => {
    const title = `1699000000099-parity-${driver}.js`;
    if (driver !== 'mongodb') {
      const table = new SqlStateStore(harness.database.ownerUrl);
      // A project that kept the starter's migrate.js: its runs land in MongoDB, the table stays empty
      await table.saveAsync({ migrations: [] } as any);
      await new MongoStateStore(deriveTestDbUri(`module-parity-${driver}`)).saveAsync({
        lastRun: title,
        migrations: [{ timestamp: 1699000000099, title }],
      } as any);
      expect(await testHelper.rest('/hub/migrations.json', { token: adminToken })).toMatchObject({
        available: false,
        hint: expect.stringContaining('still keeps the state in MongoDB'),
      });
      const refused = await testHelper.rest('/hub/actions/migrations/run', {
        headers: { 'x-hub-request': '1' },
        method: 'POST',
        payload: { confirm: 'RUN' },
        statusCode: 400,
        token: adminToken,
      });
      expect(refused.message).toContain('still keeps the state in MongoDB');
      await table.saveAsync({
        lastRun: title,
        migrations: [{ timestamp: 1699000000099, title }],
      } as any);
    } else {
      await new MongoStateStore(deriveTestDbUri(`module-parity-${driver}`)).saveAsync({
        lastRun: title,
        migrations: [{ timestamp: 1699000000099, title }],
      } as any);
    }
    const panel = await testHelper.rest('/hub/migrations.json', { token: adminToken });
    expect(panel).toMatchObject({
      completed: [title],
      lastRun: title,
      source: driver === 'mongodb' ? 'collection' : 'table',
    });
  });
  moduleIt('error-codes-and-permissions', driver, async () => {
    const translations = await testHelper.rest('/i18n/errors/de');
    expect(Object.keys(translations).length).toBeGreaterThan(0);
    const report = await testHelper.rest('/permissions/json', { token: adminToken });
    expect(report.stats).toBeDefined();
    await testHelper.rest('/permissions/json', { statusCode: 403, token: (await member('permissions-member')).token });
  });
});
