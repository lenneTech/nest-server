/**
 * Story: System Setup - Initial Admin Creation
 *
 * As a developer deploying a fresh system,
 * I want to create an initial admin user via REST API or via config/ENV,
 * So that I can access the system even when signup is disabled.
 *
 * Test scenarios:
 * - Status returns needsSetup: true when zero users
 * - Init creates admin user successfully
 * - Created admin has admin role
 * - Created admin can sign in via BetterAuth
 * - Status returns needsSetup: false after init
 * - Init returns 403 when users already exist
 * - Auto-creation via config creates admin on bootstrap
 * - Auto-created admin can sign in
 * - Auto-creation is skipped when users already exist
 *
 * ISOLATION: This test uses separate temporary MongoDB databases because it
 * requires zero users to test the "fresh deployment" scenario. Using the shared
 * e2e database would interfere with tests running in parallel.
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MongoClient } from 'mongodb';

import { CoreBetterAuthModule, CoreBetterAuthService, CoreModule, HttpExceptionLogFilter, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { Any } from '../../src/core/common/scalars/any.scalar';
import { DateScalar } from '../../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../../src/core/common/scalars/json.scalar';
import { CoreAuthService } from '../../src/core/modules/auth/services/core-auth.service';
import { CronJobs } from '../../src/server/common/services/cron-jobs.service';
import { AuthController } from '../../src/server/modules/auth/auth.controller';
import { AuthModule } from '../../src/server/modules/auth/auth.module';
import { BetterAuthModule } from '../../src/server/modules/better-auth/better-auth.module';
import { FileModule } from '../../src/server/modules/file/file.module';
import { ServerController } from '../../src/server/server.controller';

// Isolated database to avoid interfering with parallel tests
const SYSTEM_SETUP_DB = `nest-server-e2e-setup-${Date.now()}`;
const testConfig = {
  ...envConfig,
  mongoose: {
    ...envConfig.mongoose,
    uri: `mongodb://127.0.0.1/${SYSTEM_SETUP_DB}`,
  },
};

describe('Story: System Setup', () => {
  let app;
  let testHelper: TestHelper;
  let betterAuthService: CoreBetterAuthService;

  // Database
  let mongoClient: MongoClient;
  let db;

  const SETUP_ADMIN_EMAIL = `setup-admin-${Date.now()}@test.com`;
  const SETUP_ADMIN_PASSWORD = 'TestPassword123!';
  const SETUP_ADMIN_NAME = 'Setup Admin';

  // ===================================================================================================================
  // Setup & Teardown
  // ===================================================================================================================

  beforeAll(async () => {
    try {
      CoreBetterAuthModule.reset();

      @Module({
        controllers: [ServerController, AuthController],
        exports: [CoreModule, AuthModule, BetterAuthModule, FileModule],
        imports: [
          CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(testConfig.jwt), testConfig),
          ScheduleModule.forRoot(),
          AuthModule.forRoot(testConfig.jwt),
          BetterAuthModule.forRoot({}),
          FileModule,
        ],
        providers: [Any, CronJobs, DateScalar, JSONScalar, { provide: 'PUB_SUB', useValue: new PubSub() }],
      })
      class SystemSetupTestModule {}

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [SystemSetupTestModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalFilters(new HttpExceptionLogFilter());
      app.setBaseViewsDir(testConfig.templates.path);
      app.setViewEngine(testConfig.templates.engine);
      await app.init();

      testHelper = new TestHelper(app);
      betterAuthService = moduleFixture.get(CoreBetterAuthService);

      mongoClient = await MongoClient.connect(testConfig.mongoose.uri);
      db = mongoClient.db();
    } catch (e) {
      console.error('beforeAll Error', e);
      throw e;
    }
  });

  afterAll(async () => {
    // Drop the entire temporary database (no shared data to worry about)
    if (db) {
      try {
        await db.dropDatabase();
      } catch {
        // Ignore cleanup errors
      }
    }

    if (mongoClient) {
      await mongoClient.close();
    }
    if (app) {
      await app.close();
    }
    CoreBetterAuthModule.reset();
  });

  // ===================================================================================================================
  // Tests
  // ===================================================================================================================

  describe('GET /api/system-setup/status', () => {
    it('should return needsSetup: true when zero users exist', async () => {
      // Separate DB starts empty - no need to clear anything
      const result = await testHelper.rest('/api/system-setup/status', {
        method: 'GET',
        statusCode: 200,
      });

      expect(result).toBeDefined();
      expect(result.needsSetup).toBe(true);
      expect(result.betterAuthEnabled).toBe(betterAuthService.isEnabled());
    });

    it('should return needsSetup: false when users exist', async () => {
      // Ensure at least one user exists
      await db.collection('users').insertOne({
        createdAt: new Date(),
        email: 'existing@test.com',
        roles: [],
      });

      const result = await testHelper.rest('/api/system-setup/status', {
        method: 'GET',
        statusCode: 200,
      });

      expect(result).toBeDefined();
      expect(result.needsSetup).toBe(false);

      // Cleanup the test user to restore empty DB state
      await db.collection('users').deleteOne({ email: 'existing@test.com' });
    });
  });

  describe('POST /api/system-setup/init', () => {
    it('should create initial admin successfully when zero users exist', async () => {
      // DB is empty again after previous test cleanup
      const result = await testHelper.rest('/api/system-setup/init', {
        method: 'POST',
        payload: {
          email: SETUP_ADMIN_EMAIL,
          name: SETUP_ADMIN_NAME,
          password: SETUP_ADMIN_PASSWORD,
        },
        statusCode: 201,
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.email).toBe(SETUP_ADMIN_EMAIL);
    });

    it('should have created user with admin role', async () => {
      const user = await db.collection('users').findOne({ email: SETUP_ADMIN_EMAIL });

      expect(user).toBeDefined();
      expect(user.roles).toContain('admin');
      expect(user.iamId).toBeDefined();
    });

    it('should have created BetterAuth user and account', async () => {
      const user = await db.collection('users').findOne({ email: SETUP_ADMIN_EMAIL });
      expect(user).toBeDefined();
      expect(user.iamId).toBeDefined();

      // BetterAuth shares the 'users' collection (modelName: 'users')
      // The account collection links via userId (can be ObjectId or string)
      // Query by both _id and iamId to handle either format
      const account = await db.collection('account').findOne({
        $or: [{ userId: user._id }, { userId: user.iamId }],
        providerId: 'credential',
      });
      expect(account).toBeDefined();
      expect(account.password).toBeDefined();
    });

    it('should allow the created admin to sign in via BetterAuth', async () => {
      if (!betterAuthService.isEnabled()) {
        return;
      }

      // Sign in via BetterAuth REST endpoint
      const signInResult = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: {
          email: SETUP_ADMIN_EMAIL,
          password: SETUP_ADMIN_PASSWORD,
        },
        statusCode: 200,
      });

      expect(signInResult).toBeDefined();
      expect(signInResult.token || signInResult.user).toBeDefined();
    });

    it('should return needsSetup: false after init', async () => {
      const result = await testHelper.rest('/api/system-setup/status', {
        method: 'GET',
        statusCode: 200,
      });

      expect(result).toBeDefined();
      expect(result.needsSetup).toBe(false);
    });

    it('should return 403 when users already exist', async () => {
      const result = await testHelper.rest('/api/system-setup/init', {
        method: 'POST',
        payload: {
          email: `setup-second-${Date.now()}@test.com`,
          password: 'AnotherPassword123!',
        },
        statusCode: 403,
      });

      expect(result).toBeDefined();
      expect(result.message).toContain('LTNS_0050');
    });
  });
});

// =============================================================================
// Auto-Creation via Config/ENV
// =============================================================================

describe('Story: System Setup - Auto-Creation via Config', () => {
  const AUTO_DB = `nest-server-e2e-setup-auto-${Date.now()}`;
  const AUTO_ADMIN_EMAIL = `auto-admin-${Date.now()}@test.com`;
  const AUTO_ADMIN_PASSWORD = 'AutoPassword123!';
  const AUTO_ADMIN_NAME = 'Auto Admin';

  let app;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db;

  const autoConfig = {
    ...envConfig,
    mongoose: {
      ...envConfig.mongoose,
      uri: `mongodb://127.0.0.1/${AUTO_DB}`,
    },
    systemSetup: {
      initialAdmin: {
        email: AUTO_ADMIN_EMAIL,
        name: AUTO_ADMIN_NAME,
        password: AUTO_ADMIN_PASSWORD,
      },
    },
  };

  beforeAll(async () => {
    try {
      CoreBetterAuthModule.reset();

      @Module({
        controllers: [ServerController, AuthController],
        exports: [CoreModule, AuthModule, BetterAuthModule, FileModule],
        imports: [
          CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(autoConfig.jwt), autoConfig),
          ScheduleModule.forRoot(),
          AuthModule.forRoot(autoConfig.jwt),
          BetterAuthModule.forRoot({}),
          FileModule,
        ],
        providers: [Any, CronJobs, DateScalar, JSONScalar, { provide: 'PUB_SUB', useValue: new PubSub() }],
      })
      class AutoSetupTestModule {}

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AutoSetupTestModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalFilters(new HttpExceptionLogFilter());
      app.setBaseViewsDir(autoConfig.templates.path);
      app.setViewEngine(autoConfig.templates.engine);

      // app.init() triggers OnApplicationBootstrap → auto-creation
      await app.init();

      testHelper = new TestHelper(app);
      mongoClient = await MongoClient.connect(autoConfig.mongoose.uri);
      db = mongoClient.db();
    } catch (e) {
      console.error('beforeAll Error (auto-creation)', e);
      throw e;
    }
  });

  afterAll(async () => {
    if (db) {
      try {
        await db.dropDatabase();
      } catch {
        // Ignore cleanup errors
      }
    }
    if (mongoClient) {
      await mongoClient.close();
    }
    if (app) {
      await app.close();
    }
    CoreBetterAuthModule.reset();
  });

  it('should have auto-created the initial admin on bootstrap', async () => {
    const user = await db.collection('users').findOne({ email: AUTO_ADMIN_EMAIL });

    expect(user).toBeDefined();
    expect(user.roles).toContain('admin');
    expect(user.iamId).toBeDefined();
    expect(user.name).toBe(AUTO_ADMIN_NAME);
  });

  it('should report needsSetup: false after auto-creation', async () => {
    const result = await testHelper.rest('/api/system-setup/status', {
      method: 'GET',
      statusCode: 200,
    });

    expect(result).toBeDefined();
    expect(result.needsSetup).toBe(false);
  });

  it('should have created BetterAuth account for auto-created admin', async () => {
    const user = await db.collection('users').findOne({ email: AUTO_ADMIN_EMAIL });
    expect(user).toBeDefined();

    const account = await db.collection('account').findOne({
      $or: [{ userId: user._id }, { userId: user.iamId }],
      providerId: 'credential',
    });
    expect(account).toBeDefined();
    expect(account.password).toBeDefined();
  });

  it('should allow the auto-created admin to sign in via BetterAuth', async () => {
    const signInResult = await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: {
        email: AUTO_ADMIN_EMAIL,
        password: AUTO_ADMIN_PASSWORD,
      },
      statusCode: 200,
    });

    expect(signInResult).toBeDefined();
    expect(signInResult.token || signInResult.user).toBeDefined();
  });

  it('should return 403 on manual init after auto-creation', async () => {
    const result = await testHelper.rest('/api/system-setup/init', {
      method: 'POST',
      payload: {
        email: `another-admin-${Date.now()}@test.com`,
        password: 'AnotherPassword123!',
      },
      statusCode: 403,
    });

    expect(result).toBeDefined();
    expect(result.message).toContain('LTNS_0050');
  });
});

// =============================================================================
// Auto-Creation skipped when users exist
// =============================================================================

describe('Story: System Setup - Auto-Creation skipped with existing users', () => {
  const SKIP_DB = `nest-server-e2e-setup-skip-${Date.now()}`;
  const SKIP_ADMIN_EMAIL = `skip-admin-${Date.now()}@test.com`;

  let app;
  let mongoClient: MongoClient;
  let db;

  const skipConfig = {
    ...envConfig,
    mongoose: {
      ...envConfig.mongoose,
      uri: `mongodb://127.0.0.1/${SKIP_DB}`,
    },
    systemSetup: {
      initialAdmin: {
        email: SKIP_ADMIN_EMAIL,
        password: 'SkipPassword123!',
      },
    },
  };

  beforeAll(async () => {
    try {
      // Pre-populate the database with a user BEFORE app bootstrap
      mongoClient = await MongoClient.connect(skipConfig.mongoose.uri);
      db = mongoClient.db();
      await db.collection('users').insertOne({
        createdAt: new Date(),
        email: 'pre-existing@test.com',
        roles: ['admin'],
      });

      CoreBetterAuthModule.reset();

      @Module({
        controllers: [ServerController, AuthController],
        exports: [CoreModule, AuthModule, BetterAuthModule, FileModule],
        imports: [
          CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(skipConfig.jwt), skipConfig),
          ScheduleModule.forRoot(),
          AuthModule.forRoot(skipConfig.jwt),
          BetterAuthModule.forRoot({}),
          FileModule,
        ],
        providers: [Any, CronJobs, DateScalar, JSONScalar, { provide: 'PUB_SUB', useValue: new PubSub() }],
      })
      class SkipSetupTestModule {}

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [SkipSetupTestModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalFilters(new HttpExceptionLogFilter());
      app.setBaseViewsDir(skipConfig.templates.path);
      app.setViewEngine(skipConfig.templates.engine);
      await app.init();
    } catch (e) {
      console.error('beforeAll Error (skip auto-creation)', e);
      throw e;
    }
  });

  afterAll(async () => {
    if (db) {
      try {
        await db.dropDatabase();
      } catch {
        // Ignore cleanup errors
      }
    }
    if (mongoClient) {
      await mongoClient.close();
    }
    if (app) {
      await app.close();
    }
    CoreBetterAuthModule.reset();
  });

  it('should NOT have auto-created the admin when users already exist', async () => {
    const autoCreatedUser = await db.collection('users').findOne({ email: SKIP_ADMIN_EMAIL });
    expect(autoCreatedUser).toBeNull();
  });

  it('should still have the pre-existing user', async () => {
    const existingUser = await db.collection('users').findOne({ email: 'pre-existing@test.com' });
    expect(existingUser).toBeDefined();
    expect(existingUser.roles).toContain('admin');
  });
});
