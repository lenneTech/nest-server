/**
 * Story: Better-Auth with an auto-generated secret still accepts its own session cookie
 *
 * When neither `betterAuth.secret` nor a fallback secret of at least 32 characters is
 * configured (e.g. a local `.env` with a 24-character `JWT_SECRET`), Better-Auth generates a
 * secret at startup and signs with it. The NestJS layer (controller cookie helper, API
 * middleware, CoreBetterAuthService) signed with `currentConfig.secret`, which only ever picked
 * up `betterAuth.secret` or a valid fallback — never the generated one. The session cookie went
 * out unsigned, so every NATIVE Better-Auth endpoint that reads it (`/iam/token`, the MCP
 * `/iam/mcp/authorize`, passkey and 2FA) answered 401 right after a successful sign-in, and an
 * MCP OAuth login looped back to the login page.
 *
 * Separate file because NestJS GraphQL schema generation has process-level side effects when
 * several apps with different configs boot in the same worker.
 */

import { NestExpressApplication } from '@nestjs/platform-express';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { Db, MongoClient } from 'mongodb';
import supertest = require('supertest');
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthModule, CoreBetterAuthService, CoreModule, HttpExceptionLogFilter } from '../../src';
import envConfig from '../../src/config.env';
import { Any } from '../../src/core/common/scalars/any.scalar';
import { DateScalar } from '../../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../../src/core/common/scalars/json.scalar';
import { CronJobs } from '../../src/server/common/services/cron-jobs.service';
import { deriveTestDbUri } from '../db-lifecycle.reporter';

const SHORT_SECRET = 'only-24-characters-long!';
const EMAIL_PREFIX = 'generated-secret-';
// Own database: the shared run DB holds JWKS keys the other suites encrypted with the regular
// secret, which this app (running on a generated secret) cannot decrypt.
const DB_URI = deriveTestDbUri('generated-secret');

describe('Story: BetterAuth with an auto-generated secret', () => {
  let app: NestExpressApplication;
  let betterAuthService: CoreBetterAuthService;
  let mongoClient: MongoClient;
  let db: Db;

  beforeAll(async () => {
    CoreBetterAuthModule.reset();
    expect(SHORT_SECRET).toHaveLength(24);

    const testConfig = {
      ...envConfig,
      betterAuth: { ...envConfig.betterAuth, emailVerification: false, secret: undefined, signUpChecks: false },
      jwt: {
        ...envConfig.jwt,
        refresh: { ...envConfig.jwt?.refresh, secret: SHORT_SECRET },
        secret: SHORT_SECRET,
      },
      mongoose: { ...envConfig.mongoose, uri: DB_URI },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [CoreModule.forRoot(testConfig as any), ScheduleModule.forRoot()],
      providers: [Any, CronJobs, DateScalar, JSONScalar],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    await app.init();

    betterAuthService = moduleFixture.get(CoreBetterAuthService);
    mongoClient = await MongoClient.connect(DB_URI);
    db = mongoClient.db();
  }, 60000);

  afterAll(async () => {
    await db?.dropDatabase().catch(() => undefined);
    await mongoClient?.close();
    await app?.close();
    CoreBetterAuthModule.reset();
  });

  it('runs on a generated secret — neither betterAuth.secret nor a fallback is usable', () => {
    const instanceSecret = (betterAuthService.getInstance() as { options?: { secret?: string } })?.options?.secret;

    expect(instanceSecret).toBeTruthy();
    expect(instanceSecret).not.toBe(SHORT_SECRET);
  });

  it('signs the session cookie with that secret, so native Better-Auth endpoints accept it', async () => {
    const email = `${EMAIL_PREFIX}${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
    const server = app.getHttpServer();

    const signUp = await supertest(server)
      .post('/iam/sign-up/email')
      .send({ email, name: 'Generated Secret Test', password: 'SecurePassword123!', termsAndPrivacyAccepted: true });
    expect(signUp.status).toBe(201);

    const setCookie = signUp.headers['set-cookie'] as unknown as string[] | undefined;
    const cookieHeader = (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
    expect(cookieHeader).toContain('iam.session_token=');

    // `/iam/token` is served by Better-Auth itself (JWT plugin) and verifies the cookie signature.
    const token = await supertest(server).get('/iam/token').set('Cookie', cookieHeader);

    expect(token.status).toBe(200);
    expect(token.body.token).toEqual(expect.any(String));
  });
});
