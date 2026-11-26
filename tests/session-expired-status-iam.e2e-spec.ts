/**
 * 401, not 403, for a caller whose session has ended — IAM only, `CoreModule.forRoot(envConfig)` as nest-server-starter
 * assembles a project, so the request runs through `BetterAuthRolesGuard` (DEV-4393). The reference server is
 * `tests/session-expired-status.e2e-spec.ts`; the cases are shared, see `tests/helpers/session-expiry-cases.ts`.
 */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { afterAll, beforeAll, describe } from 'vitest';

import { CoreModule } from '../src';
import envConfig from '../src/config.env';
import { Any } from '../src/core/common/scalars/any.scalar';
import { DateScalar } from '../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../src/core/common/scalars/json.scalar';
import { BetterAuthModule } from '../src/server/modules/better-auth/better-auth.module';
import { type IamTestDb, openIamTestDb } from './helpers/iam-test-db';
import { registerSessionExpiryCases, SessionProbeController, SessionProbeResolver } from './helpers/session-expiry-cases';

const iamOnlyConfig = {
  ...envConfig,
  auth: { ...envConfig.auth, legacyEndpoints: { enabled: false } },
  // The project's BetterAuthModule is imported below; with the one-argument CoreModule.forRoot() CoreModule would
  // register the default resolver as well (see tests/stories/scenario-3-iam-only.e2e-spec.ts)
  betterAuth: { ...envConfig.betterAuth, autoRegister: false, enabled: true },
};

@Module({
  controllers: [SessionProbeController],
  imports: [
    CoreModule.forRoot(iamOnlyConfig),
    ScheduleModule.forRoot(),
    BetterAuthModule.forRoot({
      config: iamOnlyConfig.betterAuth,
      fallbackSecrets: [iamOnlyConfig.jwt?.secret, iamOnlyConfig.jwt?.refresh?.secret],
      serverAppUrl: iamOnlyConfig.appUrl,
      serverBaseUrl: iamOnlyConfig.baseUrl,
      serverEnv: iamOnlyConfig.env,
    }),
  ],
  providers: [Any, DateScalar, JSONScalar, SessionProbeResolver],
})
class SessionProbeIamOnlyModule {}

describe('Session expiry answers 401 — IAM only (BetterAuthRolesGuard)', () => {
  let app: any;
  let iamDb: IamTestDb;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [SessionProbeIamOnlyModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    // CoreModule.forRoot() alone registers no user model, so its users stay on MongoDB on every project
    iamDb = await openIamTestDb(iamOnlyConfig.mongoose.uri, { users: 'mongodb' });
  });

  afterAll(async () => {
    await iamDb?.close();
    await app?.close();
  });

  registerSessionExpiryCases(
    () => app,
    () => iamDb,
  );
});
