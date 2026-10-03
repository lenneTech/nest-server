import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { HttpExceptionLogFilter, RoleEnum, TestGraphQLType, TestHelper } from '../src';
import envConfig from '../src/config.env';
import { ConfigService } from '../src/core/common/services/config.service';
import { ServerModule } from '../src/server/server.module';

/**
 * Credential changes across the tenant boundary, through the real `PATCH /users/:id`.
 *
 * `multiTenancy.adminBypass: false` promises that a platform administrator has no way into a tenant's
 * data. Setting a tenant user's e-mail address or password is a way around that promise: change the
 * address, request a password reset, sign in as that person. The same holds for whoever CREATED the
 * account (`S_CREATOR` may update it, and the e-mail field is open to everyone allowed to update), which
 * in an invitation flow is the inviting administrator, permanently.
 *
 * Since 11.42.0, with multi-tenancy active and `adminBypass: false`, only the account itself changes its
 * credentials. Profile fields, administrator accounts and system work without a signed-in user are
 * unaffected; with `adminBypass` on (the default) nothing changes at all.
 *
 * @regression   11.42.0 — with adminBypass: false a platform administrator (or the account's creator)
 *   could still take over a tenant account by setting its e-mail address or password.
 * @seen-failing Make `assertCredentialChangeAllowed()` return early in
 *   src/core/modules/user/core-user.service.ts — registered as mutation
 *   `tenant-credential-change-unguarded` in tests/regression-mutations.json.
 */
describe('Tenant credential isolation (e2e)', () => {
  let app;
  let httpServer;
  let testHelper: TestHelper;
  let connection: MongoClient;
  let db;

  const PREFIX = `crediso-${Date.now()}`;
  const users: Record<
    'admin' | 'creator' | 'member' | 'otherAdmin' | 'promoted',
    { email: string; id: string; token: string }
  > = {} as never;

  const withTenancy = (multiTenancy: Record<string, unknown> | undefined) => {
    ConfigService.setConfig({ ...(envConfig as any), ...(multiTenancy ? { multiTenancy } : {}) } as any, {
      reInit: true,
    });
  };

  const signUp = async (key: keyof typeof users) => {
    const email = `${PREFIX}-${key}@testdomain.com`;
    const result = await testHelper.graphQl({
      arguments: { input: { email, firstName: key, lastName: 'Test', password: 'credIsoPassword123' } },
      fields: ['token', { user: ['id'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });
    users[key] = { email, id: result.user.id, token: result.token };
  };

  const signIn = async (key: keyof typeof users) => {
    const result = await testHelper.graphQl({
      arguments: { input: { email: users[key].email, password: 'credIsoPassword123' } },
      fields: ['token'],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });
    users[key].token = result.token;
  };

  const patch = (
    as: keyof typeof users,
    target: keyof typeof users,
    payload: Record<string, unknown>,
    statusCode: number,
  ) => testHelper.rest(`/users/${users[target].id}`, { method: 'PATCH', payload, statusCode, token: users[as].token });

  const stored = (key: keyof typeof users) => db.collection('users').findOne({ _id: new ObjectId(users[key].id) });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    app.setBaseViewsDir(envConfig.templates.path);
    app.setViewEngine(envConfig.templates.engine);
    await app.init();
    httpServer = app.getHttpServer();
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    testHelper = new TestHelper(app);

    connection = await MongoClient.connect(envConfig.mongoose.uri);
    db = connection.db();

    for (const key of ['admin', 'creator', 'member', 'otherAdmin', 'promoted'] as const) {
      await signUp(key);
    }
    await db
      .collection('users')
      .updateMany(
        { _id: { $in: [new ObjectId(users.admin.id), new ObjectId(users.otherAdmin.id)] } },
        { $set: { roles: [RoleEnum.ADMIN] } },
      );
    // The creator of the member's account — what an invitation flow records for the inviting user.
    await db
      .collection('users')
      .updateOne({ _id: new ObjectId(users.member.id) }, { $set: { createdBy: users.creator.id } });
    await signIn('admin');
    await signIn('otherAdmin');
  });

  afterEach(() => {
    withTenancy(undefined);
  });

  afterAll(async () => {
    withTenancy(undefined);
    await db?.collection('users').deleteMany({ email: { $regex: `^${PREFIX}` } });
    await connection?.close();
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    await app?.close();
  });

  describe('multi-tenancy with adminBypass: false', () => {
    it("refuses an administrator setting a tenant account's e-mail address", async () => {
      withTenancy({ adminBypass: false });

      await patch('admin', 'member', { email: `${PREFIX}-taken-over@testdomain.com` }, 403);

      expect((await stored('member'))?.email).toBe(users.member.email);
    });

    it("refuses an administrator setting a tenant account's password", async () => {
      withTenancy({ adminBypass: false });
      const before = (await stored('member'))?.password;

      await patch('admin', 'member', { password: 'adminChosenPassword123' }, 403);

      expect((await stored('member'))?.password).toBe(before);
    });

    it("refuses the account's creator setting its e-mail address", async () => {
      withTenancy({ adminBypass: false });

      await patch('creator', 'member', { email: `${PREFIX}-by-creator@testdomain.com` }, 403);

      expect((await stored('member'))?.email).toBe(users.member.email);
    });

    it('still lets an administrator change profile fields, even with the unchanged address sent along', async () => {
      withTenancy({ adminBypass: false });

      await patch('admin', 'member', { email: users.member.email, firstName: 'Renamed' }, 200);

      expect((await stored('member'))?.firstName).toBe('Renamed');
    });

    it('still lets the account change its own credentials', async () => {
      withTenancy({ adminBypass: false });
      const newEmail = `${PREFIX}-member-self@testdomain.com`;

      await patch('member', 'member', { email: newEmail }, 200);

      expect((await stored('member'))?.email).toBe(newEmail);
      await db
        .collection('users')
        .updateOne({ _id: new ObjectId(users.member.id) }, { $set: { email: users.member.email } });
    });

    /**
     * @regression   11.42.0 (found in review) — exempting ADMIN targets let an administrator promote a
     *   tenant account to ADMIN first and then change its credentials, which defeats the rule entirely.
     * @seen-failing Re-add the ADMIN-target exemption to `assertCredentialChangeAllowed()` in
     *   src/core/modules/user/core-user.service.ts — registered as mutation
     *   `tenant-credential-admin-target-exempt` in tests/regression-mutations.json.
     */
    it('refuses promote-then-change: making a tenant account an administrator does not open its credentials', async () => {
      withTenancy({ adminBypass: false });

      await patch('admin', 'promoted', { roles: [RoleEnum.ADMIN] }, 200);
      await patch('admin', 'promoted', { email: `${PREFIX}-promoted-taken@testdomain.com` }, 403);

      expect((await stored('promoted'))?.email).toBe(users.promoted.email);
    });

    it("refuses an administrator changing another administrator's credentials, too", async () => {
      withTenancy({ adminBypass: false });

      await patch('admin', 'otherAdmin', { email: `${PREFIX}-other-admin-moved@testdomain.com` }, 403);

      expect((await stored('otherAdmin'))?.email).toBe(users.otherAdmin.email.toLowerCase());
    });
  });

  describe('paired controls: the rule exists only where adminBypass: false promises isolation', () => {
    it('with adminBypass on (the default), an administrator may still set the address', async () => {
      withTenancy({});
      const newEmail = `${PREFIX}-admin-set@testdomain.com`;

      await patch('admin', 'member', { email: newEmail }, 200);

      expect((await stored('member'))?.email).toBe(newEmail);
      await db
        .collection('users')
        .updateOne({ _id: new ObjectId(users.member.id) }, { $set: { email: users.member.email } });
    });

    it('without multi-tenancy, an administrator may still set the address', async () => {
      withTenancy(undefined);
      const newEmail = `${PREFIX}-no-tenancy@testdomain.com`;

      await patch('admin', 'member', { email: newEmail }, 200);

      expect((await stored('member'))?.email).toBe(newEmail);
      await db
        .collection('users')
        .updateOne({ _id: new ObjectId(users.member.id) }, { $set: { email: users.member.email } });
    });
  });
});
