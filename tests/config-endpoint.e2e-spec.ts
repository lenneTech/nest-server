/**
 * `GET /config` in deployed environments (12.5.0): closed unless `configEndpoint` opens it, and redacted whenever it
 * answers.
 *
 * The reference `ServerController` serves the route through `configEndpointResponse()`. A local environment without
 * a setting (open, redacted) is covered by tests/server.e2e-spec.ts; every combination of environment and setting by
 * tests/unit/redact-secrets.spec.ts.
 *
 * ISOLATION: each describe boots its own application on its own database (MongoDB, and PostgreSQL in the `postgres`
 * project), because the administrator is created through the system setup, which needs an empty user base. The
 * deployed environment is `test`, a deployed stage in starter-based projects; `production` would refuse this suite's
 * mail and cookie configuration for reasons unrelated to the endpoint. Each boot REPLACES the static ConfigService
 * configuration (a second CoreModule.forRoot() would merge into it), and the Hub is off (its mail capture is refused
 * in some deployed environments).
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PubSub } from 'graphql-subscriptions';

import { CoreBetterAuthModule, CoreModule, HttpExceptionLogFilter, TestHelper } from '../src';
import envConfig from '../src/config.env';
import { Any } from '../src/core/common/scalars/any.scalar';
import { DateScalar } from '../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../src/core/common/scalars/json.scalar';
import { ConfigService } from '../src/core/common/services/config.service';
import { CoreAuthService } from '../src/core/modules/auth/services/core-auth.service';
import { CronJobs } from '../src/server/common/services/cron-jobs.service';
import { AuthController } from '../src/server/modules/auth/auth.controller';
import { AuthModule } from '../src/server/modules/auth/auth.module';
import { BetterAuthModule } from '../src/server/modules/better-auth/better-auth.module';
import { FileModule } from '../src/server/modules/file/file.module';
import { ServerController } from '../src/server/server.controller';
import { deriveTestDbUri } from './db-lifecycle.reporter';
import { type IamTestDb, openIamTestDb } from './helpers/iam-test-db';
import { onOwnPostgresDatabase, ownPostgresDatabase, type PostgresTestDatabase } from './helpers/postgres-test-db';

const PASSWORD = 'TestPassword123!';
/** Planted in the configuration of every boot: none of it may come back in plain text */
const PLANTED = {
  apiKey: 'planted-api-key-for-the-config-endpoint-suite',
  connection: { url: 'postgres://app:planted-connection-password@db.internal:5432/app' },
  password: 'planted-password-for-the-config-endpoint-suite',
};

interface IConfigApp {
  close(): Promise<void>;
  testHelper: TestHelper;
  /** A session token of an administrator */
  token: string;
}

async function bootConfigApp(suffix: string, overrides: { configEndpoint?: boolean; env: string }) {
  CoreBetterAuthModule.reset();
  const sql: PostgresTestDatabase | undefined = await ownPostgresDatabase(`config-${suffix}`);
  const config = onOwnPostgresDatabase(
    {
      ...envConfig,
      ...(overrides.configEndpoint === undefined ? {} : { configEndpoint: overrides.configEndpoint }),
      env: overrides.env,
      hub: false,
      mongoose: { ...envConfig.mongoose, uri: deriveTestDbUri(`config-${suffix}`) },
      // Under a neutral key on purpose: below a secret-named key the masker masks everything
      planted: PLANTED,
      // The administrator is created through the HTTP init, which a deployed environment opens only on purpose
      systemSetup: { httpInit: true },
    },
    sql,
  );
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
  class ConfigEndpointTestModule {}

  const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [ConfigEndpointTestModule] }).compile();
  const app = moduleFixture.createNestApplication<NestExpressApplication>();
  app.useGlobalFilters(new HttpExceptionLogFilter());
  app.setBaseViewsDir(config.templates.path);
  app.setViewEngine(config.templates.engine);
  await app.init();

  const testHelper = new TestHelper(app);
  const iamDb: IamTestDb = await openIamTestDb(config.mongoose.uri, { ownerUrl: sql?.ownerUrl });
  const email = `config-admin-${suffix}-${Date.now()}@test.com`;
  await testHelper.rest('/system-setup/init', { method: 'POST', payload: { email, password: PASSWORD }, statusCode: 201 });
  const signIn: any = await testHelper.rest('/iam/sign-in/email', {
    method: 'POST',
    payload: { email, password: PASSWORD },
    statusCode: 200,
  });
  const token = signIn.token || signIn.session?.token;
  expect(typeof token, 'precondition: the sign-in returns a token').toBe('string');

  const setup: IConfigApp = {
    async close() {
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
    testHelper,
    token,
  };
  return setup;
}

describe('GET /config in a deployed environment without configEndpoint', () => {
  let setup: IConfigApp;

  beforeAll(async () => {
    setup = await bootConfigApp('closed', { env: 'test' });
  });

  afterAll(async () => {
    await setup?.close();
  });

  /**
   * @regression   12.5.0 — `GET /config` answered in every environment; outside the local ones it is now closed
   *   unless `configEndpoint` opens it.
   * @seen-failing Drop the isConfigEndpointEnabled() check from configEndpointResponse() in
   *   src/core/common/helpers/config-endpoint.helper.ts — registered as mutation `config-endpoint-gate-removed-http`
   *   in tests/regression-mutations.json.
   */
  it('answers 404 to an administrator', async () => {
    await setup.testHelper.rest('/config', { statusCode: 404, token: setup.token });
  });

  it('still answers 401 without a session', async () => {
    await setup.testHelper.rest('/config', { statusCode: 401 });
  });
});

describe('GET /config in a deployed environment opened with configEndpoint: true', () => {
  let setup: IConfigApp;

  beforeAll(async () => {
    setup = await bootConfigApp('open', { configEndpoint: true, env: 'test' });
  });

  afterAll(async () => {
    await setup?.close();
  });

  /**
   * @regression   12.5.0 — an opened `GET /config` must still answer the REDACTED configuration.
   * @seen-failing Return the unredacted configuration from ConfigService.getRedactedConfig() in
   *   src/core/common/services/config.service.ts — registered as mutation `config-endpoint-unredacted-http` in
   *   tests/regression-mutations.json.
   */
  it('answers the configuration with every secret masked', async () => {
    const res: any = await setup.testHelper.rest('/config', { token: setup.token });
    const body = JSON.stringify(res);
    expect(res.env).toBe('test');
    for (const secret of [
      PLANTED.apiKey,
      PLANTED.password,
      'planted-connection-password',
      envConfig.jwt?.secret,
      (envConfig.betterAuth as any)?.secret,
    ]) {
      expect(body).not.toContain(secret);
    }
    expect(res.planted.connection.url).toContain('db.internal:5432');
    expect(res.planted.apiKey).toBe('***');
  });
});

describe('GET /config in a local environment closed with configEndpoint: false', () => {
  let setup: IConfigApp;

  beforeAll(async () => {
    setup = await bootConfigApp('off', { configEndpoint: false, env: 'e2e' });
  });

  afterAll(async () => {
    await setup?.close();
  });

  it('answers 404 to an administrator', async () => {
    await setup.testHelper.rest('/config', { statusCode: 404, token: setup.token });
  });
});
