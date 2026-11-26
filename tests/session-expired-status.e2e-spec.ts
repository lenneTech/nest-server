/**
 * 401, not 403, for a caller whose session has ended — the reference server, legacy and IAM side by side, so the
 * request runs through `RolesGuard` (DEV-4393). The IAM-only assembly is `tests/session-expired-status-iam.e2e-spec.ts`;
 * the cases are shared, see `tests/helpers/session-expiry-cases.ts`.
 */
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { afterAll, beforeAll, describe } from 'vitest';

import envConfig from '../src/config.env';
import { ServerModule } from '../src/server/server.module';
import { type IamTestDb, openIamTestDb } from './helpers/iam-test-db';
import { registerSessionExpiryCases, SessionProbeController, SessionProbeResolver } from './helpers/session-expiry-cases';

@Module({
  controllers: [SessionProbeController],
  imports: [ServerModule],
  providers: [SessionProbeResolver],
})
class SessionProbeServerModule {}

describe('Session expiry answers 401 — reference server (RolesGuard)', () => {
  let app: any;
  let iamDb: IamTestDb;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [SessionProbeServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    iamDb = await openIamTestDb(envConfig.mongoose.uri);
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
