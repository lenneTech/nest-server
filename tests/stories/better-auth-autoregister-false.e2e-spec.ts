/**
 * Story: BetterAuth autoRegister: false (Pattern 3)
 *
 * Tests that when autoRegister: false is set in betterAuth config,
 * CoreModule does NOT import CoreBetterAuthModule. The project
 * must import CoreBetterAuthModule.forRoot() separately.
 *
 * This is in a separate file because NestJS GraphQL schema generation
 * has process-level side effects that can interfere when multiple
 * NestJS apps with different resolvers are created in the same process.
 */

import { Controller, Get, Module } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { Server } from 'http';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CoreBetterAuthModule,
  CoreModule,
  CurrentUser,
  HttpExceptionLogFilter,
  RoleEnum,
  Roles,
  TestHelper,
} from '../../src';
import envConfig from '../../src/config.env';
import { Any } from '../../src/core/common/scalars/any.scalar';
import { DateScalar } from '../../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../../src/core/common/scalars/json.scalar';
import { CronJobs } from '../../src/server/common/services/cron-jobs.service';

// =================================================================================================
// Security Test Controller
// =================================================================================================

@Controller('security-test')
class SecurityTestController {
  @Get('public')
  @Roles(RoleEnum.S_EVERYONE)
  getPublic() {
    return { access: 'public' };
  }

  @Get('user-only')
  @Roles(RoleEnum.S_USER)
  getUserOnly(@CurrentUser() user: any) {
    return { access: 'user-only', userId: user?.id };
  }

  @Get('admin-only')
  @Roles(RoleEnum.ADMIN)
  getAdminOnly(@CurrentUser() user: any) {
    return { access: 'admin-only', userId: user?.id };
  }

  @Get('no-one')
  @Roles(RoleEnum.S_NO_ONE)
  getNoOne() {
    return { access: 'no-one' };
  }
}

const generateTestEmail = (prefix: string): string => {
  return `reg-test-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
};

// =================================================================================================
// Tests
// =================================================================================================

describe('Story: BetterAuth autoRegister: false (Pattern 3)', () => {
  let app: NestExpressApplication;
  let httpServer: Server;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;
  let userEmail: string;
  let userPassword: string;
  let userToken: string;

  beforeAll(async () => {
    CoreBetterAuthModule.reset();

    const testConfig = {
      ...envConfig,
      betterAuth: {
        ...envConfig.betterAuth,
        autoRegister: false,
        emailVerification: false,
        enabled: true,
        signUpChecks: false,
      },
    };

    // When autoRegister: false, CoreModule does NOT import CoreBetterAuthModule.
    // The project must import it separately (like this IamModule).
    @Module({
      controllers: [SecurityTestController],
      exports: [CoreModule],
      imports: [
        CoreModule.forRoot(testConfig),
        // Project's own BetterAuth module — the single registrant
        CoreBetterAuthModule.forRoot({
          config: testConfig.betterAuth,
          fallbackSecrets: [testConfig.jwt?.secret, testConfig.jwt?.refresh?.secret],
          registerRolesGuardGlobally: true,
          serverAppUrl: testConfig.appUrl,
          serverBaseUrl: testConfig.baseUrl,
          serverEnv: testConfig.env,
        }),
        ScheduleModule.forRoot(),
      ],
      providers: [Any, CronJobs, DateScalar, JSONScalar],
    })
    class AutoRegisterFalseTestModule {}

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AutoRegisterFalseTestModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    await app.init();

    httpServer = app.getHttpServer();
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (httpServer.address() as any).port;
    testHelper = new TestHelper(app, `ws://127.0.0.1:${port}/graphql`);

    mongoClient = new MongoClient('mongodb://127.0.0.1:27017');
    await mongoClient.connect();
    db = mongoClient.db('nest-server-local');

    // Create a test user
    userEmail = generateTestEmail('autoregister-false');
    userPassword = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6test';

    const signUp = await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email: userEmail, name: 'AutoRegister False Test', password: userPassword },
      statusCode: 201,
    });
    userToken = signUp.token;
  }, 60000);

  afterAll(async () => {
    // Cleanup test data
    if (db) {
      await db.collection('users').deleteMany({ email: { $regex: /^reg-test-autoregister-false/ } });
      await db.collection('session').deleteMany({});
      await db.collection('account').deleteMany({});
    }
    if (mongoClient) {
      await mongoClient.close();
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    if (app) {
      await app.close();
    }
    CoreBetterAuthModule.reset();
  });

  it('should have IAM endpoints from project-registered module', async () => {
    const result = await testHelper.rest('/iam/features', {
      method: 'GET',
      statusCode: 200,
    });
    expect(result).toBeDefined();
  });

  it('should have RolesGuard globally registered', async () => {
    // Public endpoint works
    const publicResult = await testHelper.rest('/security-test/public', {
      method: 'GET',
      statusCode: 200,
    });
    expect(publicResult.access).toBe('public');

    // Protected endpoint requires auth
    await testHelper.rest('/security-test/user-only', {
      method: 'GET',
      statusCode: 401,
    });
  });

  it('should enforce @Roles(S_USER) — 200 with auth', async () => {
    const result = await testHelper.rest('/security-test/user-only', {
      method: 'GET',
      statusCode: 200,
      token: userToken,
    });
    expect(result.access).toBe('user-only');
    expect(result.userId).toBeDefined();
  });

  it('should enforce @Roles(ADMIN) — 403 without admin role', async () => {
    await testHelper.rest('/security-test/admin-only', {
      method: 'GET',
      statusCode: 403,
      token: userToken,
    });
  });

  it('should enforce @Roles(S_NO_ONE) — 401 always', async () => {
    // S_NO_ONE throws UnauthorizedException (401) in RolesGuard, not ForbiddenException (403)
    await testHelper.rest('/security-test/no-one', {
      method: 'GET',
      statusCode: 401,
      token: userToken,
    });
  });

  it('should have middleware active (_authenticatedViaBetterAuth flag)', async () => {
    // Authenticated request should succeed on protected endpoint
    const result = await testHelper.rest('/security-test/user-only', {
      method: 'GET',
      statusCode: 200,
      token: userToken,
    });
    expect(result.userId).toBeDefined();
  });
});
