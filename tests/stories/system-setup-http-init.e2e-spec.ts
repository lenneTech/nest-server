/**
 * Story: System Setup - the anonymous HTTP init is fail-closed outside the local environments (12.4.0)
 *
 * As the operator of a deployed instance,
 * I want `POST /system-setup/init` to be closed unless I opened it on purpose,
 * So that nobody can make themselves administrator of a fresh deployment before I set it up.
 *
 * Every combination of environment, `systemSetup.httpInit` and setup token, over HTTP through the TestHelper:
 * - deployed environment, no setting        → status `httpInitEnabled: false`, init 403 LTNS_0053, no user created
 * - deployed environment, `httpInit: true`  → init 201
 * - deployed environment, `httpInit: { token }` → 403 LTNS_0054 without or with a wrong token, 201 with the right one
 * - local environment, `httpInit: false`    → init 403 LTNS_0053
 * - local environment, `httpInit: { token }` → the token is required there too
 * - deployed environment with `initialAdmin` → the admin is created at boot, the HTTP init stays closed
 * - a failure after the user was created    → the user is removed again, `needsSetup` stays true, a retry succeeds
 *
 * The local environment WITHOUT a setting (unchanged behaviour) is covered by tests/stories/system-setup.e2e-spec.ts.
 *
 * ISOLATION: every describe boots its own application on its own database (MongoDB, and PostgreSQL in the `postgres`
 * project), because each needs the zero-user state of a fresh deployment. The deployed environments are `develop`
 * and `test` — both deployed stages in starter-based projects — rather than `production`, whose own guards (mail
 * transport, cookie and secret checks) would refuse this suite's configuration for reasons unrelated to the setup.
 * For the same reason the Hub is off: the e2e configuration captures mail there, which `develop` refuses. Each boot
 * also REPLACES the static ConfigService configuration, since a second CoreModule.forRoot() would merge into it.
 * The unit spec tests/unit/system-setup-http-init.spec.ts covers `production`, `staging` and unknown names.
 */

import { Logger, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PubSub } from 'graphql-subscriptions';
import { vi } from 'vitest';

import { CoreBetterAuthModule, CoreModule, HttpExceptionLogFilter, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { Any } from '../../src/core/common/scalars/any.scalar';
import { DateScalar } from '../../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../../src/core/common/scalars/json.scalar';
import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreAuthService } from '../../src/core/modules/auth/services/core-auth.service';
import { CoreBetterAuthUserMapper } from '../../src/core/modules/better-auth/core-better-auth-user.mapper';
import { CronJobs } from '../../src/server/common/services/cron-jobs.service';
import { AuthController } from '../../src/server/modules/auth/auth.controller';
import { AuthModule } from '../../src/server/modules/auth/auth.module';
import { BetterAuthModule } from '../../src/server/modules/better-auth/better-auth.module';
import { FileModule } from '../../src/server/modules/file/file.module';
import { ServerController } from '../../src/server/server.controller';
import { deriveTestDbUri } from '../db-lifecycle.reporter';
import { type IamTestDb, openIamTestDb } from '../helpers/iam-test-db';
import { onOwnPostgresDatabase, ownPostgresDatabase, type PostgresTestDatabase } from '../helpers/postgres-test-db';

const TOKEN = 'setup-token-for-the-e2e-suite-0123456789';
const PASSWORD = 'TestPassword123!';

interface ISetupApp {
  app: any;
  /** What the application logged at `error` level while it booted */
  bootErrors: string[];
  close(): Promise<void>;
  iamDb: IamTestDb;
  testHelper: TestHelper;
}

/** Boot the reference stack on a database of its own with `env` and `systemSetup` replaced */
async function bootSetupApp(suffix: string, overrides: { env: string; systemSetup?: Record<string, unknown> }) {
  CoreBetterAuthModule.reset();
  const sql: PostgresTestDatabase | undefined = await ownPostgresDatabase(`setup-${suffix}`);
  const config = onOwnPostgresDatabase(
    {
      ...envConfig,
      env: overrides.env,
      // The e2e configuration captures mail in the Hub, which CoreHubModule refuses in a deployed environment such
      // as `develop`; the setup story does not need the Hub at all
      hub: false,
      mongoose: { ...envConfig.mongoose, uri: deriveTestDbUri(`setup-${suffix}`) },
      systemSetup: overrides.systemSetup ?? {},
    },
    sql,
  );
  // The ConfigService is static, and a second CoreModule.forRoot() in one process MERGES into the previous
  // configuration: a token or an initialAdmin of an earlier describe would survive into this boot. Replace it.
  ConfigService.setConfig(config as any, { reInit: true });

  @Module({
    controllers: [ServerController, AuthController],
    exports: [CoreModule, AuthModule, BetterAuthModule, FileModule],
    imports: [
      CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(config.jwt), config),
      ScheduleModule.forRoot(),
      AuthModule.forRoot(config.jwt),
      BetterAuthModule.forRoot({}),
      FileModule,
    ],
    providers: [Any, CronJobs, DateScalar, JSONScalar, { provide: 'PUB_SUB', useValue: new PubSub() }],
  })
  class SetupHttpInitTestModule {}

  const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [SetupHttpInitTestModule] }).compile();
  const app = moduleFixture.createNestApplication<NestExpressApplication>();
  app.useGlobalFilters(new HttpExceptionLogFilter());
  app.setBaseViewsDir(config.templates.path);
  app.setViewEngine(config.templates.engine);

  // The boot report is part of what this story asserts. The spy is local to the boot and restored right after it,
  // so an unexpected error in a test still reaches the reporter.
  const bootErrors: string[] = [];
  const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(((message: unknown) => {
    bootErrors.push(String(message));
  }) as never);
  try {
    // app.init() runs OnApplicationBootstrap: the initialAdmin auto-creation and the boot report
    await app.init();
  } finally {
    errorSpy.mockRestore();
  }

  const iamDb = await openIamTestDb(config.mongoose.uri, { ownerUrl: sql?.ownerUrl });
  const setup: ISetupApp = {
    app,
    bootErrors,
    async close() {
      // App first: dropping while the app is alive races against async initialisation re-creating the database
      await app.close();
      try {
        await iamDb.mongo.dropDatabase();
      } catch {
        // Ignore cleanup errors
      }
      await iamDb.close();
      await sql?.drop();
      CoreBetterAuthModule.reset();
    },
    iamDb,
    testHelper: new TestHelper(app),
  };
  return setup;
}

const status = (setup: ISetupApp) => setup.testHelper.rest('/system-setup/status', { method: 'GET', statusCode: 200 });

const init = (setup: ISetupApp, email: string, statusCode: number, headers?: Record<string, string>) =>
  setup.testHelper.rest('/system-setup/init', {
    headers,
    method: 'POST',
    payload: { email, password: PASSWORD },
    statusCode,
  });

describe('Story: System Setup HTTP init - deployed environment without a setting', () => {
  let setup: ISetupApp;

  beforeAll(async () => {
    setup = await bootSetupApp('http-closed', { env: 'test' });
  });

  afterAll(async () => {
    await setup?.close();
  });

  it('reports the HTTP init as unavailable', async () => {
    expect(await status(setup)).toMatchObject({
      httpInitEnabled: false,
      httpInitTokenRequired: false,
      needsSetup: true,
    });
  });

  /**
   * @regression   12.4.0 — POST /system-setup/init was open in every environment: a deployed instance without
   *   `systemSetup.initialAdmin` could be taken over by whoever called it before the first sign-up.
   * @seen-failing Remove the assertHttpInitAllowed() call from createInitialAdmin() in
   *   src/core/modules/system-setup/core-system-setup.controller.ts — registered as mutation
   *   `system-setup-controller-skips-gate` in tests/regression-mutations.json.
   */
  it('refuses the init with LTNS_0053 and creates no user', async () => {
    const result = await init(setup, `intruder-${Date.now()}@test.com`, 403);
    expect(result.message).toContain('LTNS_0053');
    expect(await setup.iamDb.countUsers({})).toBe(0);
    expect((await status(setup)).needsSetup).toBe(true);
  });

  it('refuses the init with LTNS_0053 even with a token, since none is configured', async () => {
    const result = await init(setup, `intruder-${Date.now()}@test.com`, 403, { 'x-system-setup-token': TOKEN });
    expect(result.message).toContain('LTNS_0053');
  });

  it('said at boot that the instance cannot be set up, and how to fix it', () => {
    const report = setup.bootErrors.find((message) => message.includes('cannot be set up'));
    expect(report).toBeDefined();
    expect(report).toContain('NSC__SYSTEM_SETUP__INITIAL_ADMIN__EMAIL');
    expect(report).toContain('NSC__SYSTEM_SETUP__HTTP_INIT__TOKEN');
  });
});

describe('Story: System Setup HTTP init - deployed environment opened with `httpInit: true`', () => {
  let setup: ISetupApp;
  const email = `opened-admin-${Date.now()}@test.com`;

  beforeAll(async () => {
    setup = await bootSetupApp('http-open', { env: 'develop', systemSetup: { httpInit: true } });
  });

  afterAll(async () => {
    await setup?.close();
  });

  it('reports the HTTP init as available without a token', async () => {
    expect(await status(setup)).toMatchObject({ httpInitEnabled: true, httpInitTokenRequired: false, needsSetup: true });
  });

  it('creates the initial admin', async () => {
    const result = await init(setup, email, 201);
    expect(result).toMatchObject({ email, success: true });
    const user = await setup.iamDb.findUser({ email });
    expect(user?.roles).toContain('admin');
  });

  it('is locked once the admin exists', async () => {
    expect((await status(setup)).needsSetup).toBe(false);
    const result = await init(setup, `second-${Date.now()}@test.com`, 403);
    expect(result.message).toContain('LTNS_0050');
  });
});

describe('Story: System Setup HTTP init - deployed environment with a setup token', () => {
  let setup: ISetupApp;
  const email = `token-admin-${Date.now()}@test.com`;

  beforeAll(async () => {
    setup = await bootSetupApp('http-token', { env: 'develop', systemSetup: { httpInit: { token: TOKEN } } });
  });

  afterAll(async () => {
    await setup?.close();
  });

  it('reports that a token is required', async () => {
    expect(await status(setup)).toMatchObject({ httpInitEnabled: true, httpInitTokenRequired: true, needsSetup: true });
  });

  /**
   * @regression   12.4.0 — a token-protected init must refuse a request without the configured token.
   * @seen-failing Return true from isSystemSetupTokenValid() in
   *   src/core/modules/system-setup/system-setup-http-init.helper.ts — registered as mutation
   *   `system-setup-http-token-not-compared` in tests/regression-mutations.json.
   */
  it('refuses the init with LTNS_0054 without a token or with a wrong one', async () => {
    const missing = await init(setup, email, 403);
    expect(missing.message).toContain('LTNS_0054');
    const wrong = await init(setup, email, 403, { 'x-system-setup-token': `${TOKEN}-wrong` });
    expect(wrong.message).toContain('LTNS_0054');
    expect(await setup.iamDb.countUsers({})).toBe(0);
  });

  it('creates the initial admin with the right token, sent in any letter case', async () => {
    const result = await init(setup, email, 201, { 'X-System-Setup-Token': TOKEN });
    expect(result).toMatchObject({ email, success: true });
    expect((await setup.iamDb.findUser({ email }))?.roles).toContain('admin');
  });
});

describe('Story: System Setup HTTP init - local environment', () => {
  describe('closed explicitly with `httpInit: false`', () => {
    let setup: ISetupApp;

    beforeAll(async () => {
      setup = await bootSetupApp('http-local-off', { env: 'e2e', systemSetup: { httpInit: false } });
    });

    afterAll(async () => {
      await setup?.close();
    });

    it('refuses the init with LTNS_0053', async () => {
      expect((await status(setup)).httpInitEnabled).toBe(false);
      const result = await init(setup, `local-${Date.now()}@test.com`, 403);
      expect(result.message).toContain('LTNS_0053');
    });
  });

  describe('with a setup token', () => {
    let setup: ISetupApp;
    const email = `local-token-${Date.now()}@test.com`;

    beforeAll(async () => {
      setup = await bootSetupApp('http-local-token', { env: 'e2e', systemSetup: { httpInit: { token: TOKEN } } });
    });

    afterAll(async () => {
      await setup?.close();
    });

    it('requires the token there too', async () => {
      expect((await status(setup)).httpInitTokenRequired).toBe(true);
      expect((await init(setup, email, 403)).message).toContain('LTNS_0054');
      expect(await init(setup, email, 201, { 'x-system-setup-token': TOKEN })).toMatchObject({ success: true });
    });
  });
});

describe('Story: System Setup HTTP init - deployed environment with initialAdmin', () => {
  let setup: ISetupApp;
  const email = `env-admin-${Date.now()}@test.com`;

  beforeAll(async () => {
    setup = await bootSetupApp('http-initial-admin', {
      env: 'develop',
      systemSetup: { initialAdmin: { email, name: 'Env Admin', password: PASSWORD } },
    });
  });

  afterAll(async () => {
    await setup?.close();
  });

  it('creates the admin at boot, unchanged by the closed HTTP init', async () => {
    const user = await setup.iamDb.findUser({ email });
    expect(user?.roles).toContain('admin');
    expect(await status(setup)).toMatchObject({ httpInitEnabled: false, needsSetup: false });
  });

  it('lets the admin sign in', async () => {
    const result = await setup.testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email, password: PASSWORD },
      statusCode: 200,
    });
    expect(result.token || result.user).toBeDefined();
  });

  it('reports no setup problem at boot', () => {
    expect(setup.bootErrors.filter((message) => message.includes('cannot be set up'))).toEqual([]);
  });

  it('keeps the HTTP init closed', async () => {
    expect((await init(setup, `second-${Date.now()}@test.com`, 403)).message).toContain('LTNS_0053');
  });
});

describe('Story: System Setup - a failure after the user was created', () => {
  let setup: ISetupApp;
  const email = `rollback-admin-${Date.now()}@test.com`;

  beforeAll(async () => {
    setup = await bootSetupApp('rollback', { env: 'e2e' });
  });

  afterAll(async () => {
    await setup?.close();
  });

  /**
   * @regression   12.4.0 — a failure AFTER createUser (linkAccount, the sync, the role update) released only the
   *   claim: the IAM user stayed, `needsSetup` turned false for good and the deployment had no administrator.
   * @seen-failing Drop the rollbackInitialAdmin() call from the catch of createInitialAdmin() in
   *   src/core/modules/system-setup/core-system-setup.service.ts — registered as mutation
   *   `system-setup-http-failed-init-keeps-user` in tests/regression-mutations.json.
   */
  it('removes the partially created user, so setup stays possible', async () => {
    const mapper = setup.app.get(CoreBetterAuthUserMapper, { strict: false });
    const sync = vi.spyOn(mapper, 'linkOrCreateUser').mockRejectedValueOnce(new Error('forced failure after createUser'));
    const errors: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation(((message: unknown) => {
      errors.push(String(message));
    }) as never);

    const result = await init(setup, email, 403);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(result.message).toContain('LTNS_0050');
    expect(errors.some((message) => message.includes('forced failure after createUser'))).toBe(true);

    expect(await setup.iamDb.countUsers({})).toBe(0);
    expect((await status(setup)).needsSetup).toBe(true);
  });

  it('accepts the retry', async () => {
    expect(await init(setup, email, 201)).toMatchObject({ email, success: true });
    const user = await setup.iamDb.findUser({ email });
    expect(user?.roles).toContain('admin');
    expect(await setup.iamDb.credentialAccount(user.id)).toBeTruthy();
  });
});
