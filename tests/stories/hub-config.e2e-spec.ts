/**
 * Story: Hub activation is explicit and its path is configurable
 *
 * - With no `hub` config the module is not registered → every Hub route answers 404 (no implicit access).
 * - With a custom `hub.path` the cockpit moves there and the default `/hub` no longer exists.
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';

import { CoreBetterAuthModule, CoreModule, HttpExceptionLogFilter, IServerOptions, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { Any } from '../../src/core/common/scalars/any.scalar';
import { DateScalar } from '../../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../../src/core/common/scalars/json.scalar';
import { CoreAuthService } from '../../src/core/modules/auth/services/core-auth.service';
import { TusModule } from '../../src/core/modules/tus';
import { CronJobs } from '../../src/server/common/services/cron-jobs.service';
import { AuthModule } from '../../src/server/modules/auth/auth.module';
import { BetterAuthModule } from '../../src/server/modules/better-auth/better-auth.module';
import { FileModule } from '../../src/server/modules/file/file.module';
import { ServerController } from '../../src/server/server.controller';

async function bootApp(hub: IServerOptions['hub'], overrides: Partial<IServerOptions> = {}): Promise<{ app: any; testHelper: TestHelper }> {
  const config: IServerOptions = { ...envConfig, hub, ...overrides };

  @Module({
    controllers: [ServerController],
    imports: [
      CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(config.jwt), config),
      ScheduleModule.forRoot(),
      AuthModule.forRoot(config.jwt),
      BetterAuthModule.forRoot({}),
      FileModule,
      TusModule.forRoot(),
    ],
    providers: [Any, CronJobs, DateScalar, JSONScalar],
  })
  class HubConfigTestModule {}

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [HubConfigTestModule],
    providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
  }).compile();

  const app: any = moduleFixture.createNestApplication();
  app.useGlobalFilters(new HttpExceptionLogFilter());
  app.setBaseViewsDir(config.templates.path);
  app.setViewEngine(config.templates.engine);
  await app.init();
  return { app, testHelper: new TestHelper(app) };
}

describe('Story: Hub activation & custom path', () => {
  describe('disabled (no hub config)', () => {
    let app: any;
    let testHelper: TestHelper;

    beforeAll(async () => {
      ({ app, testHelper } = await bootApp(undefined));
    });

    afterAll(async () => {
      if (app) {
        await app.close();
      }
      CoreBetterAuthModule.reset();
    });

    it('answers 404 on every Hub route (no implicit access)', async () => {
      await testHelper.rest('/hub', { method: 'GET', statusCode: 404 });
      await testHelper.rest('/hub/dashboard.json', { method: 'GET', statusCode: 404 });
      await testHelper.rest('/hub/hub.js', { method: 'GET', statusCode: 404 });
    });
  });

  describe('custom path', () => {
    let app: any;
    let testHelper: TestHelper;

    beforeAll(async () => {
      ({ app, testHelper } = await bootApp({ path: 'admin/cockpit' }));
    });

    afterAll(async () => {
      if (app) {
        await app.close();
      }
      CoreBetterAuthModule.reset();
    });

    it('serves the shell under the custom path (public chrome) and gates its data (401)', async () => {
      await testHelper.rest('/admin/cockpit', { method: 'GET', statusCode: 200 });
      await testHelper.rest('/admin/cockpit/dashboard.json', { method: 'GET', statusCode: 401 });
    });

    it('serves the public routes under the custom path', async () => {
      await testHelper.rest('/admin/cockpit/hub.js', { method: 'GET', statusCode: 200 });
      await testHelper.rest('/admin/cockpit/auth', { method: 'GET', statusCode: 200 });
    });

    it('no longer serves the default /hub path', async () => {
      await testHelper.rest('/hub', { method: 'GET', statusCode: 404 });
    });
  });

  describe('actions disabled', () => {
    let app: any;
    let testHelper: TestHelper;

    beforeAll(async () => {
      ({ app, testHelper } = await bootApp({ actions: false, roles: false }));
    });

    afterAll(async () => {
      if (app) {
        await app.close();
      }
      CoreBetterAuthModule.reset();
    });

    it('answers 404 on action routes (the actions controller is not registered)', async () => {
      await testHelper.rest('/hub/actions/collectors/traces/clear', {
        headers: { 'x-hub-request': '1' },
        method: 'POST',
        payload: { confirm: 'CLEAR' },
        statusCode: 404,
      });
      // Read routes still work.
      await testHelper.rest('/hub/dashboard.json', { method: 'GET', statusCode: 200 });
    });
  });

  describe('optional-source resolution (error-code enabled)', () => {
    let app: any;
    let testHelper: TestHelper;

    beforeAll(async () => {
      // Enable error-code auto-registration (the shared e2e config disables it) so the Hub's
      // ModuleRef-based optional-source resolution has a real CoreErrorCodeService to find.
      ({ app, testHelper } = await bootApp({ roles: false }, { errorCode: {} }));
    });

    afterAll(async () => {
      if (app) {
        await app.close();
      }
      CoreBetterAuthModule.reset();
    });

    it('resolves the optional sources (routes + error codes) via ModuleRef', async () => {
      const routes = await testHelper.rest('/hub/routes.json', { method: 'GET', statusCode: 200 });
      expect(routes.available, `routes.json payload: ${JSON.stringify(routes).slice(0, 120)}`).not.toBe(false);

      const data = await testHelper.rest('/hub/error-codes.json', { method: 'GET', statusCode: 200 });
      expect(data.available, `error-codes.json payload: ${JSON.stringify(data).slice(0, 120)}`).not.toBe(false);
      expect(Array.isArray(data.codes)).toBe(true);
      expect(data.codes.length).toBeGreaterThan(0);
    });
  });
});
