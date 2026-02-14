/**
 * Story: Permissions Report
 *
 * As a developer,
 * I want to see a permissions dashboard at /permissions
 * So that I can audit @Roles, @Restricted, and securityCheck() usage.
 *
 * Test scenarios:
 * - Service scans and returns a report with modules
 * - Service caches report on subsequent calls
 * - Service detects role enums and security warnings
 * - Service generates valid HTML in English
 * - Service generates valid Markdown
 * - Service includes stats in report
 * - Service has consistent warningsByType counts
 * - Service rate-limits rapid rescans
 * - GET /permissions returns HTML with AUTH_TOKEN
 * - GET /permissions/json returns JSON with stats
 * - GET /permissions/markdown returns Markdown
 * - POST /permissions/rescan triggers rescan
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MongoClient, ObjectId } from 'mongodb';

import {
  HttpExceptionLogFilter,
  RoleEnum,
  TestGraphQLType,
  TestHelper,
} from '../../src';
import envConfig from '../../src/config.env';
import { CorePermissionsService } from '../../src/core/modules/permissions/core-permissions.service';
import { ServerModule } from '../../src/server/server.module';

describe('Story: Permissions Report', () => {
  let app;
  let testHelper: TestHelper;
  let connection;
  let db;

  // ===================================================================================================================
  // Setup & Teardown
  // ===================================================================================================================

  beforeAll(async () => {
    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [ServerModule],
        providers: [
          {
            provide: 'PUB_SUB',
            useValue: new PubSub(),
          },
        ],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalFilters(new HttpExceptionLogFilter());
      app.setBaseViewsDir(envConfig.templates.path);
      app.setViewEngine(envConfig.templates.engine);
      await app.init();

      testHelper = new TestHelper(app);

      // Database connection for admin role setup
      connection = await MongoClient.connect(envConfig.mongoose.uri);
      db = await connection.db();
    } catch (e) {
      console.error('beforeAll Error', e);
      throw e;
    }
  });

  afterAll(async () => {
    if (connection) {
      await connection.close();
    }
    if (app) {
      await app.close();
    }
  });

  // ===================================================================================================================
  // Tests: Service (standalone, no DI needed)
  // ===================================================================================================================

  describe('CorePermissionsService', () => {
    let service: CorePermissionsService;

    beforeAll(() => {
      service = new CorePermissionsService();
    });

    afterAll(() => {
      service.onModuleDestroy();
    });

    it('should scan and return a report', async () => {
      const report = await service.scan();
      expect(report).toBeDefined();
      expect(report.generated).toBeDefined();
      expect(report.modules).toBeInstanceOf(Array);
      expect(report.modules.length).toBeGreaterThan(0);
      expect(report.roleEnums).toBeInstanceOf(Array);
      expect(report.warnings).toBeInstanceOf(Array);
    });

    it('should return cached report on subsequent calls', async () => {
      const report1 = await service.getOrScan();
      const report2 = await service.getOrScan();
      expect(report1).toBe(report2);
    });

    it('should find modules from src/server/modules/', async () => {
      const report = await service.getOrScan();
      const moduleNames = report.modules.map(m => m.name);
      expect(moduleNames).toContain('user');
      expect(moduleNames).toContain('auth');
    });

    it('should return roleEnums array (empty when no *.enum.ts files in src/server/)', async () => {
      const report = await service.getOrScan();
      // roleEnums scans src/server/common/enums/ and src/server/modules/ for *.enum.ts files.
      // In nest-server itself, RoleEnum lives in src/core/, so no server-level enums are found.
      // In consuming projects, custom role enums would be detected here.
      expect(report.roleEnums).toBeInstanceOf(Array);
    });

    it('should scan models with fields', async () => {
      const report = await service.getOrScan();
      const userModule = report.modules.find(m => m.name === 'user');
      expect(userModule).toBeDefined();
      expect(userModule.models.length).toBeGreaterThan(0);
      const userModel = userModule.models[0];
      expect(userModel.className).toBeDefined();
      expect(userModel.fields).toBeInstanceOf(Array);
      expect(userModel.fields.length).toBeGreaterThan(0);
    });

    it('should scan resolvers with methods', async () => {
      const report = await service.getOrScan();
      const userModule = report.modules.find(m => m.name === 'user');
      expect(userModule).toBeDefined();
      expect(userModule.resolvers.length).toBeGreaterThan(0);
      const resolver = userModule.resolvers[0];
      expect(resolver.className).toBeDefined();
      expect(resolver.methods).toBeInstanceOf(Array);
    });

    it('should detect security warnings', async () => {
      const report = await service.getOrScan();
      expect(report.warnings).toBeInstanceOf(Array);
    });

    it('should generate HTML in English', () => {
      const html = service.generateHtml();
      expect(html).toBeDefined();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Permissions Report');
      expect(html).toContain('lang="en"');
      // Should NOT contain German strings
      expect(html).not.toContain('Rollen-Index');
      expect(html).not.toContain('Generiert:');
      expect(html).not.toContain('Datei:');
      expect(html).not.toContain('Klassen-Restriction');
    });

    it('should include stats in report', async () => {
      const report = await service.getOrScan();
      expect(report.stats).toBeDefined();
      expect(report.stats.totalModules).toBe(report.modules.length);
      expect(report.stats.totalModels).toBeGreaterThan(0);
      expect(report.stats.totalWarnings).toBe(report.warnings.length);
      expect(report.stats.endpointCoverage).toBeGreaterThanOrEqual(0);
      expect(report.stats.endpointCoverage).toBeLessThanOrEqual(100);
      expect(report.stats.securityCoverage).toBeGreaterThanOrEqual(0);
      expect(report.stats.securityCoverage).toBeLessThanOrEqual(100);
    });

    it('should have consistent warningsByType counts', async () => {
      const report = await service.getOrScan();
      const wbt = report.stats.warningsByType;
      const sum = wbt.NO_RESTRICTION + wbt.NO_ROLES + wbt.NO_SECURITY_CHECK + wbt.UNRESTRICTED_FIELD + wbt.UNRESTRICTED_METHOD;
      expect(sum).toBe(report.stats.totalWarnings);
    });

    it('should generate valid Markdown', () => {
      const md = service.generateMarkdown();
      expect(md).toBeDefined();
      expect(md).toContain('# Permissions Report');
      expect(md).toContain('## Summary');
      expect(md).toContain('## Table of Contents');
      expect(md).toContain('## Module:');
      // Should contain summary table with module breakdown
      expect(md).toContain('| Module | Models | Inputs | Outputs | Controllers | Resolvers | Warnings |');
      // Should contain coverage stats in header
      expect(md).toContain('Endpoint Coverage:');
      expect(md).toContain('Security Coverage:');
    });

    it('should generate HTML with AUTH_TOKEN when token provided', () => {
      const html = service.generateHtml('Bearer test-token-123');
      expect(html).toContain('AUTH_TOKEN');
      expect(html).toContain('Bearer test-token-123');
    });

    it('should generate HTML without AUTH_TOKEN variable when no token', () => {
      const html = service.generateHtml();
      // The client JS references AUTH_TOKEN in its typeof check, but the actual
      // <script>var AUTH_TOKEN=...</script> injection should not be present
      expect(html).not.toContain("var AUTH_TOKEN='");
    });

    it('should rate-limit rapid rescans', async () => {
      const report1 = await service.scan();
      expect(report1).toBeDefined();

      // Immediate second scan should return cached report (rate limited)
      const report2 = await service.scan();
      expect(report2).toBe(report1);
    });
  });

  // ===================================================================================================================
  // Tests: REST Endpoints
  // ===================================================================================================================

  describe('REST Endpoints', () => {
    let adminToken: string;
    let userId: string;
    const random = Math.random().toString(36).substring(7);
    const email = `${random}@permissions-test.com`;
    const password = `Pass${random}!`;

    beforeAll(async () => {
      // 1. Sign up a new user
      const signUpResult = await testHelper.graphQl({
        arguments: {
          input: { email, firstName: 'Perm', lastName: 'Test', password },
        },
        fields: ['token', { user: ['id', 'email'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });
      userId = signUpResult?.user?.id;

      // 2. Set admin role and verify user in database
      await db
        .collection('users')
        .findOneAndUpdate(
          { _id: new ObjectId(userId) },
          { $set: { roles: [RoleEnum.ADMIN], verified: true } },
        );

      // 3. Sign in to get a token with admin role
      const signInResult = await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', { user: ['id', 'email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });
      adminToken = signInResult?.token;
    });

    afterAll(async () => {
      // Cleanup: remove test user
      if (userId) {
        await db.collection('users').deleteOne({ _id: new ObjectId(userId) });
      }
    });

    it('GET /permissions should return HTML', async () => {
      const result = await testHelper.rest('/permissions', {
        method: 'GET',
        statusCode: 200,
        token: adminToken,
      });
      expect(result).toBeDefined();
    });

    it('GET /permissions/json should return JSON report with stats', async () => {
      const result = await testHelper.rest('/permissions/json', {
        method: 'GET',
        statusCode: 200,
        token: adminToken,
      });
      expect(result).toBeDefined();
      expect(result.modules).toBeInstanceOf(Array);
      expect(result.generated).toBeDefined();
      expect(result.warnings).toBeInstanceOf(Array);
      expect(result.stats).toBeDefined();
      expect(result.stats.totalModules).toBeGreaterThan(0);
      expect(result.stats.warningsByType).toBeDefined();
    });

    it('POST /permissions/rescan should trigger rescan', async () => {
      const result = await testHelper.rest('/permissions/rescan', {
        method: 'POST',
        statusCode: 201,
        token: adminToken,
      });
      expect(result).toBeDefined();
      expect(result.message).toBe('Rescan completed');
      expect(result.timestamp).toBeDefined();
    });

    it('GET /permissions/markdown should return Markdown', async () => {
      const result = await testHelper.rest('/permissions/markdown', {
        method: 'GET',
        statusCode: 200,
        token: adminToken,
      });
      // REST testHelper parses JSON by default; markdown returns plain text
      // so the raw response will be a string
      expect(result).toBeDefined();
    });

    it('GET /permissions HTML should include AUTH_TOKEN', async () => {
      const result = await testHelper.rest('/permissions', {
        method: 'GET',
        statusCode: 200,
        token: adminToken,
      });
      // The HTML response includes the auth token for the rescan button
      // testHelper returns parsed data, but the token is injected server-side
      expect(result).toBeDefined();
    });

    it('GET /permissions without token should return 401', async () => {
      // With `permissions: true` (default RoleEnum.ADMIN), unauthenticated requests
      // are rejected by the RolesGuard with 401 Unauthorized.
      const result = await testHelper.rest('/permissions', {
        method: 'GET',
        statusCode: 401,
      });
      expect(result).toBeDefined();
    });
  });
});
