import { Controller, Get, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { CoreModule, CurrentUser, RoleEnum, Roles, TestHelper } from '../src';
import { CoreBetterAuthModule } from '../src/core/modules/better-auth/core-better-auth.module';
import { AuthModule } from '../src/server/modules/auth/auth.module';
import { AuthController } from '../src/server/modules/auth/auth.controller';
import { CoreAuthService } from '../src/core/modules/auth/services/core-auth.service';
import { BetterAuthModule } from '../src/server/modules/better-auth/better-auth.module';
import { UserModule } from '../src/server/modules/user/user.module';
import { Any } from '../src/core/common/scalars/any.scalar';
import { DateScalar } from '../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../src/core/common/scalars/json.scalar';
import { deriveTestDbUri } from './db-lifecycle.reporter';

/**
 * Does a signed-in caller keep their identity on a PUBLIC endpoint?
 *
 * `@Roles(S_EVERYONE)` grants access without authentication — correctly. The question this spec
 * answers is a different one: when such a caller DOES send a valid token, is `@CurrentUser()` still
 * populated? An endpoint that is public AND personalises for signed-in callers (a search ranking by
 * the caller's own location, a list marking the caller's own entries) silently degrades to anonymous
 * otherwise, with no error and no log.
 *
 * The two configurations answer differently and that is the whole point of testing both:
 *
 * - BetterAuth ENABLED — `CoreBetterAuthMiddleware` is applied via `forRoutes('(.*)')`, so it runs
 *   on public routes too and sets `req.user` BEFORE any guard. Identity survives regardless of what
 *   the guard does.
 * - BetterAuth DISABLED (legacy JWT only) — no such middleware exists, so the ONLY thing that could
 *   populate `req.user` is the guard, and the guard returns early for a public route.
 *
 * So the blast radius of the guard's early return is the legacy-JWT configuration, not every
 * deployment. A fix that only patches the guard is therefore necessary for that configuration and
 * inert for the other — which is exactly what these cases pin.
 */

/** Public probe: reports whether the request arrived identified. */
@Controller('identity-probe')
class IdentityProbeController {
  @Get('public')
  @Roles(RoleEnum.S_EVERYONE)
  publicEndpoint(@CurrentUser() user: any) {
    return { email: user?.email ?? null, identified: !!user?.id, userId: user?.id ?? null };
  }

  @Get('protected')
  @Roles(RoleEnum.S_USER)
  protectedEndpoint(@CurrentUser() user: any) {
    return { email: user?.email ?? null, identified: !!user?.id, userId: user?.id ?? null };
  }
}

describe('Public endpoint identity — BetterAuth ENABLED', () => {
  const email = `probe-ba-${Date.now()}@test.com`;
  const password = 'ProbePassword123!';
  let app: any;
  let testHelper: TestHelper;
  let token: string | undefined;
  let mongoClient: MongoClient;

  const config = { ...envConfig, mongoose: { ...envConfig.mongoose, uri: deriveTestDbUri('probe-ba') } };

  beforeAll(async () => {
    CoreBetterAuthModule.reset();

    @Module({
      controllers: [IdentityProbeController, AuthController],
      imports: [
        CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(config.jwt), config),
        ScheduleModule.forRoot(),
        AuthModule.forRoot(config.jwt),
        BetterAuthModule.forRoot({}),
        UserModule,
      ],
      providers: [Any, DateScalar, JSONScalar, { provide: 'PUB_SUB', useValue: new PubSub() }],
    })
    class ProbeBaModule {}

    const fixture: TestingModule = await Test.createTestingModule({ imports: [ProbeBaModule] }).compile();
    app = fixture.createNestApplication();
    await app.init();
    testHelper = new TestHelper(app);

    await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: 'Probe', password, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });

    mongoClient = await MongoClient.connect(config.mongoose.uri);
    const db = mongoClient.db();
    await db.collection('users').updateOne({ email }, { $set: { emailVerified: true, verified: true } });
    await db.collection('iam_user').updateOne({ email }, { $set: { emailVerified: true } });

    const signIn = await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email, password },
      statusCode: 200,
    });
    token = signIn?.token;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (mongoClient) {
      await mongoClient.close();
    }
    CoreBetterAuthModule.reset();
  });

  it('identifies a signed-in caller on a PROTECTED endpoint (baseline)', async () => {
    expect(token, 'sign-in must yield a token or this spec proves nothing').toBeTruthy();
    const res = await testHelper.rest('/identity-probe/protected', { token });
    expect(res.identified).toBe(true);
    expect(res.email).toBe(email);
  });

  it('identifies a signed-in caller on a PUBLIC endpoint — the middleware runs on all routes', async () => {
    const res = await testHelper.rest('/identity-probe/public', { token });
    expect(res.identified).toBe(true);
    expect(res.email).toBe(email);
  });

  it('leaves an anonymous caller anonymous on the PUBLIC endpoint, without erroring', async () => {
    const res = await testHelper.rest('/identity-probe/public');
    expect(res.identified).toBe(false);
    expect(res.email).toBeNull();
  });

  it('does not turn an INVALID token into a 401 on the PUBLIC endpoint', async () => {
    const res = await testHelper.rest('/identity-probe/public', { token: 'not-a-real-token' });
    expect(res.identified).toBe(false);
  });
});

/**
 * The configuration where the guard is the ONLY thing that could identify the caller.
 *
 * Without BetterAuth there is no `forRoutes('(.*)')` middleware, so nothing populates `req.user`
 * before the guard runs — and the guard returns early for a public route, before authenticating.
 * This is the configuration PR #591 was reported from (an upgrade from 11.1.13, where the
 * S_EVERYONE branch was evaluated AFTER the user had been resolved).
 */
describe('Public endpoint identity — legacy JWT, BetterAuth DISABLED', () => {
  const email = `probe-jwt-${Date.now()}@test.com`;
  const password = 'ProbePassword123!';
  let app: any;
  let testHelper: TestHelper;
  let token: string | undefined;

  const config: any = {
    ...envConfig,
    betterAuth: { enabled: false },
    mongoose: { ...envConfig.mongoose, uri: deriveTestDbUri('probe-jwt') },
  };

  beforeAll(async () => {
    CoreBetterAuthModule.reset();

    @Module({
      controllers: [IdentityProbeController, AuthController],
      imports: [
        CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(config.jwt), config),
        ScheduleModule.forRoot(),
        AuthModule.forRoot(config.jwt),
        UserModule,
      ],
      providers: [Any, DateScalar, JSONScalar, { provide: 'PUB_SUB', useValue: new PubSub() }],
    })
    class ProbeJwtModule {}

    const fixture: TestingModule = await Test.createTestingModule({ imports: [ProbeJwtModule] }).compile();
    app = fixture.createNestApplication();
    await app.init();
    testHelper = new TestHelper(app);

    const signUp = await testHelper.rest('/auth/signup', {
      method: 'POST',
      payload: { email, password },
      statusCode: 201,
    });
    token = signUp?.token;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    CoreBetterAuthModule.reset();
  });

  it('identifies a signed-in caller on a PROTECTED endpoint (baseline)', async () => {
    expect(token, 'legacy sign-up must yield a token or this spec proves nothing').toBeTruthy();
    const res = await testHelper.rest('/identity-probe/protected', { token });
    expect(res.identified).toBe(true);
    expect(res.email).toBe(email);
  });

  it('identifies a signed-in caller on a PUBLIC endpoint', async () => {
    const res = await testHelper.rest('/identity-probe/public', { token });
    expect(res.identified).toBe(true);
    expect(res.email).toBe(email);
  });

  it('leaves an anonymous caller anonymous on the PUBLIC endpoint, without erroring', async () => {
    const res = await testHelper.rest('/identity-probe/public');
    expect(res.identified).toBe(false);
  });

  it('does not turn an INVALID token into a 401 on the PUBLIC endpoint', async () => {
    const res = await testHelper.rest('/identity-probe/public', { token: 'not-a-real-token' });
    expect(res.identified).toBe(false);
  });
});
