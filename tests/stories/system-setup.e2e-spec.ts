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
 * ISOLATION: This test uses separate temporary databases (MongoDB, and PostgreSQL in the
 * `postgres` project) because it requires zero users to test the "fresh deployment" scenario.
 * Using the shared e2e database would interfere with tests running in parallel.
 *
 * The 11.37.0 issuer defect this suite used to pin only exists on better-auth 1.7.0–1.7.2, which
 * this repository no longer installs; it is pinned by unit specs that simulate that line
 * (tests/unit/better-auth-account-issuer-writes.spec.ts).
 */

import { Module } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import type { Db } from 'mongodb';

import { CoreBetterAuthModule, CoreBetterAuthService, CoreModule, HttpExceptionLogFilter, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { Any } from '../../src/core/common/scalars/any.scalar';
import { DateScalar } from '../../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../../src/core/common/scalars/json.scalar';
import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreAuthService } from '../../src/core/modules/auth/services/core-auth.service';
import { CoreBetterAuthUserMapper } from '../../src/core/modules/better-auth/core-better-auth-user.mapper';
import { CoreSystemSetupService } from '../../src/core/modules/system-setup/core-system-setup.service';
import { CronJobs } from '../../src/server/common/services/cron-jobs.service';
import { AuthController } from '../../src/server/modules/auth/auth.controller';
import { AuthModule } from '../../src/server/modules/auth/auth.module';
import { BetterAuthModule } from '../../src/server/modules/better-auth/better-auth.module';
import { FileModule } from '../../src/server/modules/file/file.module';
import { ServerController } from '../../src/server/server.controller';
import { deriveTestDbUri } from '../db-lifecycle.reporter';
import { type IamTestDb, openIamTestDb } from '../helpers/iam-test-db';
import { onOwnPostgresDatabase, ownPostgresDatabase, type PostgresTestDatabase } from '../helpers/postgres-test-db';


// Isolated database to avoid interfering with parallel tests. Derived from the
// current (per-run, per-worker) test DB name so the db-lifecycle cleanup owns it —
// a hardcoded `...-setup-${Date.now()}` name escaped the per-run scheme and leaked
// two databases per run (collected only by the 1h legacy rule).
const baseTestConfig = {
  ...envConfig,
  mongoose: {
    ...envConfig.mongoose,
    uri: deriveTestDbUri('setup'),
  },
};

describe('Story: System Setup', () => {
  let app;
  let testHelper: TestHelper;
  let betterAuthService: CoreBetterAuthService;

  // Database
  let db: Db;
  let iamDb: IamTestDb;
  let sql: PostgresTestDatabase | undefined;

  const SETUP_ADMIN_EMAIL = `setup-admin-${Date.now()}@test.com`;
  const SETUP_ADMIN_PASSWORD = 'TestPassword123!';
  const SETUP_ADMIN_NAME = 'Setup Admin';

  // ===================================================================================================================
  // Setup & Teardown
  // ===================================================================================================================

  beforeAll(async () => {
    try {
      CoreBetterAuthModule.reset();
      sql = await ownPostgresDatabase('setup');
      const testConfig = onOwnPostgresDatabase(baseTestConfig, sql);

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

      iamDb = await openIamTestDb(testConfig.mongoose.uri, { ownerUrl: sql?.ownerUrl });
      db = iamDb.mongo;
    } catch (e) {
      console.error('beforeAll Error', e);
      throw e;
    }
  });

  afterAll(async () => {
    // Close the app BEFORE dropping: modules still finishing async initialisation
    // (e.g. AI module collection/index creation) re-create the database when it is
    // dropped while the app is alive — that race is exactly how dropped `-setup-`
    // databases used to reappear as empty leftovers.
    if (app) {
      await app.close();
    }
    // Drop the entire temporary database (no shared data to worry about)
    if (iamDb) {
      try {
        await db.dropDatabase();
      } catch {
        // Ignore cleanup errors
      }
    }
    if (iamDb) {
      await iamDb.close();
    }
    await sql?.drop();
    CoreBetterAuthModule.reset();
  });

  // ===================================================================================================================
  // Tests
  // ===================================================================================================================

  describe('GET /system-setup/status', () => {
    it('should return needsSetup: true when zero users exist', async () => {
      // Separate DB starts empty - no need to clear anything
      const result = await testHelper.rest('/system-setup/status', {
        method: 'GET',
        statusCode: 200,
      });

      expect(result).toBeDefined();
      expect(result.needsSetup).toBe(true);
      expect(result.betterAuthEnabled).toBe(betterAuthService.isEnabled());
    });

    it('should return needsSetup: false when users exist', async () => {
      // Ensure at least one user exists
      await iamDb.insertUser({
        createdAt: new Date(),
        email: 'existing@test.com',
        roles: [],
      });

      const result = await testHelper.rest('/system-setup/status', {
        method: 'GET',
        statusCode: 200,
      });

      expect(result).toBeDefined();
      expect(result.needsSetup).toBe(false);

      // Cleanup the test user to restore empty DB state
      await iamDb.deleteUsers({ email: 'existing@test.com' });
    });
  });

  describe('POST /system-setup/init', () => {
    it('should create initial admin successfully when zero users exist', async () => {
      // DB is empty again after previous test cleanup
      const result = await testHelper.rest('/system-setup/init', {
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
      const user = await iamDb.findUser({ email: SETUP_ADMIN_EMAIL });

      expect(user).toBeDefined();
      expect(user.roles).toContain('admin');
      expect(user.iamId).toBeDefined();
    });

    it('should have created BetterAuth user and account', async () => {
      const user = await iamDb.findUser({ email: SETUP_ADMIN_EMAIL });
      expect(user).toBeDefined();
      expect(user.iamId).toBeDefined();

      // BetterAuth shares the 'users' collection (modelName: 'users'); its credential account links to that user
      const account = await iamDb.credentialAccount(user.id);
      expect(account).toBeTruthy();
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
      const result = await testHelper.rest('/system-setup/status', {
        method: 'GET',
        statusCode: 200,
      });

      expect(result).toBeDefined();
      expect(result.needsSetup).toBe(false);
    });

    it('should return 403 when users already exist', async () => {
      const result = await testHelper.rest('/system-setup/init', {
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
  const AUTO_ADMIN_EMAIL = `auto-admin-${Date.now()}@test.com`;
  const AUTO_ADMIN_PASSWORD = 'AutoPassword123!';
  const AUTO_ADMIN_NAME = 'Auto Admin';

  let app;
  let testHelper: TestHelper;
  let db: Db;
  let iamDb: IamTestDb;
  let sql: PostgresTestDatabase | undefined;

  const baseAutoConfig = {
    ...envConfig,
    mongoose: {
      ...envConfig.mongoose,
      uri: deriveTestDbUri('setup-auto'),
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
      sql = await ownPostgresDatabase('setup-auto');
      const autoConfig = onOwnPostgresDatabase(baseAutoConfig, sql);

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
      iamDb = await openIamTestDb(autoConfig.mongoose.uri, { ownerUrl: sql?.ownerUrl });
      db = iamDb.mongo;
    } catch (e) {
      console.error('beforeAll Error (auto-creation)', e);
      throw e;
    }
  });

  afterAll(async () => {
    // App first — see the first afterAll above: dropping while the app is alive
    // races against async module initialisation re-creating the database.
    if (app) {
      await app.close();
    }
    if (iamDb) {
      try {
        await db.dropDatabase();
      } catch {
        // Ignore cleanup errors
      }
    }
    if (iamDb) {
      await iamDb.close();
    }
    await sql?.drop();
    CoreBetterAuthModule.reset();
  });

  it('should have auto-created the initial admin on bootstrap', async () => {
    const user = await iamDb.findUser({ email: AUTO_ADMIN_EMAIL });

    expect(user).toBeDefined();
    expect(user.roles).toContain('admin');
    expect(user.iamId).toBeDefined();
    expect(user.name).toBe(AUTO_ADMIN_NAME);
  });

  it('should report needsSetup: false after auto-creation', async () => {
    const result = await testHelper.rest('/system-setup/status', {
      method: 'GET',
      statusCode: 200,
    });

    expect(result).toBeDefined();
    expect(result.needsSetup).toBe(false);
  });

  it('should have created BetterAuth account for auto-created admin', async () => {
    const user = await iamDb.findUser({ email: AUTO_ADMIN_EMAIL });
    expect(user).toBeDefined();

    const account = await iamDb.credentialAccount(user.id);
    expect(account).toBeTruthy();
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
    const result = await testHelper.rest('/system-setup/init', {
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
// Concurrent bootstrap (multi-replica)
// =============================================================================

describe('Story: System Setup - Concurrent bootstrap', () => {
  const RACE_ADMIN_EMAIL = `race-admin-${Date.now()}@test.com`;

  let app;
  let db: Db;
  let iamDb: IamTestDb;
  let services: CoreSystemSetupService[];
  let sql: PostgresTestDatabase | undefined;

  const baseRaceConfig = {
    ...envConfig,
    mongoose: {
      ...envConfig.mongoose,
      uri: deriveTestDbUri('setup-race'),
    },
    systemSetup: {
      initialAdmin: {
        email: RACE_ADMIN_EMAIL,
        password: 'RacePassword123!',
      },
    },
  };

  beforeAll(async () => {
    try {
      CoreBetterAuthModule.reset();
      sql = await ownPostgresDatabase('setup-race');
      const raceConfig = onOwnPostgresDatabase(baseRaceConfig, sql);

      @Module({
        controllers: [ServerController, AuthController],
        exports: [CoreModule, AuthModule, BetterAuthModule, FileModule],
        imports: [
          CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(raceConfig.jwt), raceConfig),
          ScheduleModule.forRoot(),
          AuthModule.forRoot(raceConfig.jwt),
          BetterAuthModule.forRoot({}),
          FileModule,
        ],
        providers: [Any, CronJobs, DateScalar, JSONScalar, { provide: 'PUB_SUB', useValue: new PubSub() }],
      })
      class RaceSetupTestModule {}

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [RaceSetupTestModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalFilters(new HttpExceptionLogFilter());
      app.setBaseViewsDir(raceConfig.templates.path);
      app.setViewEngine(raceConfig.templates.engine);
      await app.init();

      iamDb = await openIamTestDb(raceConfig.mongoose.uri, { ownerUrl: sql?.ownerUrl });
      db = iamDb.mongo;

      // app.init() already ran the bootstrap once. Reset to a fresh-deployment state so
      // the two instances below start the race from zero users and an unclaimed marker.
      // deleteMany, not drop: dropping `users` would drop its unique email index, which is what
      // prevents a duplicate admin. Kept as a loop because three documents quote this verbatim as
      // "the framework's own reset" — a snippet nobody runs drifts; this one runs every suite.
      if (iamDb.driver === 'mongodb') {
        for (const col of ['users', 'account', 'session', 'system-setup-locks']) {
          await db.collection(col).deleteMany({});
        }
      } else {
        // The same reset on a PostgreSQL default source: every user with its sessions and accounts, and the claim's row
        await iamDb.deleteUsers({});
        await iamDb.clearSetupClaim();
      }

      // Two service instances sharing one database = two replicas booting simultaneously.
      const connection = moduleFixture.get(getConnectionToken());
      const betterAuthService = moduleFixture.get(CoreBetterAuthService);
      const userMapper = moduleFixture.get(CoreBetterAuthUserMapper);
      const configService = moduleFixture.get(ConfigService);
      services = [
        new CoreSystemSetupService(connection, betterAuthService, userMapper, configService),
        new CoreSystemSetupService(connection, betterAuthService, userMapper, configService),
      ];
    } catch (e) {
      console.error('beforeAll Error (concurrent bootstrap)', e);
      throw e;
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (iamDb) {
      try {
        await db.dropDatabase();
      } catch {
        // Ignore cleanup errors
      }
    }
    if (iamDb) {
      await iamDb.close();
    }
    await sql?.drop();
    CoreBetterAuthModule.reset();
  });

  it('should create exactly one admin when two instances bootstrap concurrently', async () => {
    await Promise.all(services.map((service) => service.onApplicationBootstrap()));

    expect(await iamDb.countUsers({ email: RACE_ADMIN_EMAIL })).toBe(1);
    expect((await iamDb.findUser({ email: RACE_ADMIN_EMAIL }))!.roles).toContain('admin');

    // No second user slipped in through the other instance either
    expect(await iamDb.countUsers({})).toBe(1);
  });

  it('should keep the claim marker so later boots skip the setup', async () => {
    const marker = await iamDb.setupClaim();
    expect(marker).toBeTruthy();
    // MongoDB keeps the 12.0.0 marker document, PostgreSQL a lease row
    expect(marker!.claimedAt ?? marker!.acquiredAt).toBeDefined();
  });

  /**
   * The reset trap, pinned from the consumer's side.
   *
   * Emptying `users` is the reflex for replaying the setup flow, and it is not enough: the claim
   * marker is released only when creation FAILS, so it outlives a SUCCESSFUL setup by design.
   * Both guards in createInitialAdmin() raise the same ErrorCode, so the response cannot say
   * which one fired — a suite that just emptied `users` is told users exist while the collection
   * is empty. That cost a consumer project a full CI cycle to diagnose.
   *
   * These two cases exist so that behaviour cannot change silently in either direction: if the
   * marker is ever released on success, the first goes red; if the documented remedy stops
   * working, the second does.
   */
  it('refuses a fresh init when only `users` was cleared — the claim outlives a successful setup', async () => {
    await iamDb.deleteUsers({});
    expect(await iamDb.countUsers({})).toBe(0);
    expect(await iamDb.setupClaim()).toBeTruthy();

    // A bare `.rejects.toThrow()` would be satisfied by ANY failure — a misconfigured BetterAuth,
    // a dropped connection — and would still look like evidence. Pin the actual refusal.
    let caught: any;
    try {
      await services[0].createInitialAdmin({
        email: `reset-${Date.now()}@test.com`,
        password: 'ResetPassword123!',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught, 'init must be refused while the claim is held').toBeDefined();
    expect(caught.getStatus?.()).toBe(403);
    expect(JSON.stringify(caught.getResponse?.() ?? caught.message)).toContain('LTNS_0050');
    // And no user was created as a side effect of the refused attempt.
    expect(await iamDb.countUsers({})).toBe(0);
  });

  it('accepts a fresh init once `system-setup-locks` is cleared too — the documented remedy', async () => {
    // Precondition, asserted rather than assumed: this case depends on state the previous one
    // leaves behind. Run alone (or under `-t` filtering, or sharded) there would be no claim to
    // clear, `deleteMany` would be a no-op, and the case would pass GREEN without ever
    // exercising the remedy it is named after — a false pass, which is worse than a false fail.
    expect(await iamDb.setupClaim()).toBeTruthy();

    await iamDb.clearSetupClaim();

    const email = `reset-ok-${Date.now()}@test.com`;
    const result = await services[0].createInitialAdmin({ email, password: 'ResetPassword123!' });

    expect(result.success).toBe(true);
    expect(await iamDb.countUsers({})).toBe(1);
  });
});

// =============================================================================
// Auto-Creation skipped when users exist
// =============================================================================

describe('Story: System Setup - Auto-Creation skipped with existing users', () => {
  // Derive from the current (per-run) test DB name so an aborted run's leftover
  // is collected by the db-lifecycle reporter of the next successful run.
  // Short suffix only: the run DB name is already unique, and MongoDB caps
  // database names at 63 characters.
  const SKIP_DB = `${envConfig.mongoose.uri.split('/').pop().split('?')[0]}-skip`;
  const SKIP_ADMIN_EMAIL = `skip-admin-${Date.now()}@test.com`;

  let app;
  let db: Db;
  let iamDb: IamTestDb;
  let sql: PostgresTestDatabase | undefined;

  const baseSkipConfig = {
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
      sql = await ownPostgresDatabase('setup-skip');
      const skipConfig = onOwnPostgresDatabase(baseSkipConfig, sql);
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

      // Pre-populate the database with a user BEFORE app bootstrap. The bootstrap hook runs in app.init(), the schema of
      // a PostgreSQL users table is created when the module is compiled — so the user is planted in between.
      iamDb = await openIamTestDb(skipConfig.mongoose.uri, { ownerUrl: sql?.ownerUrl });
      db = iamDb.mongo;
      await iamDb.insertUser({
        createdAt: new Date(),
        email: 'pre-existing@test.com',
        roles: ['admin'],
      });

      await app.init();
    } catch (e) {
      console.error('beforeAll Error (skip auto-creation)', e);
      throw e;
    }
  });

  afterAll(async () => {
    // App first — see the first afterAll above: dropping while the app is alive
    // races against async module initialisation re-creating the database.
    if (app) {
      await app.close();
    }
    if (iamDb) {
      try {
        await db.dropDatabase();
      } catch {
        // Ignore cleanup errors
      }
    }
    if (iamDb) {
      await iamDb.close();
    }
    await sql?.drop();
    CoreBetterAuthModule.reset();
  });

  it('should NOT have auto-created the admin when users already exist', async () => {
    const autoCreatedUser = await iamDb.findUser({ email: SKIP_ADMIN_EMAIL });
    expect(autoCreatedUser).toBeNull();
  });

  it('should still have the pre-existing user', async () => {
    const existingUser = await iamDb.findUser({ email: 'pre-existing@test.com' });
    expect(existingUser).toBeDefined();
    expect(existingUser.roles).toContain('admin');
  });
});
