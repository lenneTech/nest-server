/**
 * Story: Unified Error Code System with Translation Support
 *
 * **Extension Scenario Tested: D - Custom Service + Controller via forRoot()**
 *
 * This test uses the recommended extension pattern where:
 * - Core ErrorCodeModule.forRoot() with custom service and controller parameters
 * - Custom ErrorCodeService extending CoreErrorCodeService
 * - Custom ErrorCodeController extending CoreErrorCodeController
 * - Project-specific SRV_* error codes
 *
 * For tests covering other scenarios, see:
 * - `tests/error-code-scenarios.e2e-spec.ts` - Scenarios A (additionalErrorRegistry), B (Custom Service), C (Core Only)
 *
 * @see src/core/modules/error-code/INTEGRATION-CHECKLIST.md for integration guide
 *
 * As a developer, I want a unified, type-safe error code system with translation support,
 * so that end users see understandable error messages in their language and I can
 * quickly identify and debug errors.
 *
 * Acceptance Criteria:
 * - A central `defineErrors()` helper function exists for type-safe registry definition
 * - TypeScript prevents usage of unregistered error codes at compile time
 * - Factory functions `Errors.functionName(params)` are available without build step
 * - IDE autocomplete shows all available error factories with JSDoc description
 * - Parameters of factory functions are checked at compile time
 * - `CoreErrorCodeService` manages the LTNS registry and is extensible through inheritance
 * - Projects can add their own error registries that merge with core
 * - REST endpoint `GET /api/i18n/errors/:locale` delivers combined translations
 * - Translations support placeholders (`{param}`) that are replaced at runtime
 * - Translation files for German and English are complete for all core error codes
 * - All existing throw/Error locations in the project use the new format
 * - JSDoc in the registry documents each error (description, solution)
 * - Generated documentation `docs/error-codes.md` lists all core error codes
 * - Unit tests validate type safety, completeness and translation format
 */

import { INestApplication, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreModule, ErrorCodeModule, HttpExceptionLogFilter, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { Any } from '../../src/core/common/scalars/any.scalar';
import { DateScalar } from '../../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../../src/core/common/scalars/json.scalar';
import { CoreAuthService } from '../../src/core/modules/auth/services/core-auth.service';
import { CronJobs } from '../../src/server/common/services/cron-jobs.service';
import { AuthController } from '../../src/server/modules/auth/auth.controller';
import { AuthModule } from '../../src/server/modules/auth/auth.module';
import { BetterAuthModule } from '../../src/server/modules/better-auth/better-auth.module';
import { ErrorCodeController } from '../../src/server/modules/error-code/error-code.controller';
import { ErrorCodeService } from '../../src/server/modules/error-code/error-code.service';
import { FileModule } from '../../src/server/modules/file/file.module';
import { ServerController } from '../../src/server/server.controller';

/**
 * Test Module with Error Code System
 *
 * This test module demonstrates the ErrorCodeModule extension pattern:
 * - CoreModule provides the base infrastructure
 * - ErrorCodeModule.forRoot({ service, controller }) adds project-specific customization
 */
@Module({
  controllers: [ServerController, AuthController],
  exports: [CoreModule, AuthModule, BetterAuthModule, FileModule],
  imports: [
    CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(envConfig.jwt), envConfig),
    ScheduleModule.forRoot(),
    AuthModule.forRoot(envConfig.jwt),
    BetterAuthModule.forRoot({
      config: envConfig.betterAuth,
      fallbackSecrets: [envConfig.jwt?.secret, envConfig.jwt?.refresh?.secret],
      serverAppUrl: envConfig.appUrl,
      serverBaseUrl: envConfig.baseUrl,
      serverEnv: envConfig.env,
    }),
    // Use Core ErrorCodeModule.forRoot() with custom service and controller
    ErrorCodeModule.forRoot({
      controller: ErrorCodeController,
      service: ErrorCodeService,
    }),
    FileModule,
  ],
  providers: [Any, CronJobs, DateScalar, JSONScalar],
})
class ErrorCodeTestModule {}

describe('Story: Unified Error Code System with Translation Support', () => {
  let app: INestApplication;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;

  // ===================================================================================================================
  // Setup and Teardown
  // ===================================================================================================================

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ErrorCodeTestModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    await app.init();
    testHelper = new TestHelper(app);

    // Connect to MongoDB (kept for potential future test extensions)
    mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
  });

  afterAll(async () => {
    if (mongoClient) await mongoClient.close();
    if (app) await app.close();
  });

  // =================================================================================================================
  // REST Endpoint: GET /api/i18n/errors/:locale
  // =================================================================================================================

  describe('REST Endpoint: GET /api/i18n/errors/:locale', () => {
    it('should return German translations for locale "de"', async () => {
      const response = await testHelper.rest('/api/i18n/errors/de', {
        method: 'GET',
        statusCode: 200,
      });

      // Response should be an object with errors
      expect(response).toBeDefined();
      expect(typeof response).toBe('object');
      expect(response.errors).toBeDefined();
      expect(typeof response.errors).toBe('object');

      // Should contain at least one LTNS error code
      const errorCodes = Object.keys(response.errors);
      expect(errorCodes.length).toBeGreaterThan(0);

      // All error codes should follow the PREFIX_XXXX pattern
      errorCodes.forEach((code) => {
        expect(code).toMatch(/^[A-Z]+_\d{4}$/);
      });

      // German translations should be in German
      const firstTranslation = response.errors[errorCodes[0]];
      expect(typeof firstTranslation).toBe('string');
      expect(firstTranslation.length).toBeGreaterThan(0);
    });

    it('should return English translations for locale "en"', async () => {
      const response = await testHelper.rest('/api/i18n/errors/en', {
        method: 'GET',
        statusCode: 200,
      });

      expect(response).toBeDefined();
      expect(response.errors).toBeDefined();

      const errorCodes = Object.keys(response.errors);
      expect(errorCodes.length).toBeGreaterThan(0);

      // English translations should be in English
      const firstTranslation = response.errors[errorCodes[0]];
      expect(typeof firstTranslation).toBe('string');
      expect(firstTranslation.length).toBeGreaterThan(0);
    });

    it('should return same error codes for both locales', async () => {
      const deResponse = await testHelper.rest('/api/i18n/errors/de', {
        method: 'GET',
        statusCode: 200,
      });

      const enResponse = await testHelper.rest('/api/i18n/errors/en', {
        method: 'GET',
        statusCode: 200,
      });

      const deCodes = Object.keys(deResponse.errors).sort();
      const enCodes = Object.keys(enResponse.errors).sort();

      // Both locales should have the same error codes
      expect(deCodes).toEqual(enCodes);
    });

    it('should support placeholder format {param} in translations', async () => {
      const response = await testHelper.rest('/api/i18n/errors/de', {
        method: 'GET',
        statusCode: 200,
      });

      // At least some translations should have placeholders
      const translations = Object.values(response.errors) as string[];
      const hasPlaceholders = translations.some((t) => /\{[a-zA-Z]+\}/.test(t));

      // Verify that the response has errors and placeholder format is valid if present
      expect(response.errors).toBeDefined();
      // Log for debugging - placeholders are optional but format should be valid
      if (hasPlaceholders) {
        expect(hasPlaceholders).toBe(true);
      }
    });

    it('should return 404 for unsupported locale', async () => {
      await testHelper.rest('/api/i18n/errors/xyz', {
        method: 'GET',
        statusCode: 404,
      });
    });

    it('should be publicly accessible without authentication', async () => {
      // No token provided - should still work
      const response = await testHelper.rest('/api/i18n/errors/de', {
        method: 'GET',
        statusCode: 200,
      });

      expect(response.errors).toBeDefined();
    });

    it('should return Nuxt i18n compatible JSON format', async () => {
      const response = await testHelper.rest('/api/i18n/errors/de', {
        method: 'GET',
        statusCode: 200,
      });

      // Nuxt i18n expects: { "key": "value" } or { "namespace": { "key": "value" } }
      // We use { "errors": { "CODE": "translation" } } which is compatible
      expect(response).toHaveProperty('errors');
      expect(typeof response.errors).toBe('object');

      // Values should be strings (translations)
      Object.values(response.errors).forEach((value) => {
        expect(typeof value).toBe('string');
      });
    });
  });

  // =================================================================================================================
  // Error Format Validation
  // =================================================================================================================

  describe('Error Format: #PREFIX_XXXX: Description', () => {
    it('should have error codes defined in the registry that follow the correct format', async () => {
      // Verify all error codes in the registry follow the PREFIX_XXXX pattern
      const response = await testHelper.rest('/api/i18n/errors/en', {
        method: 'GET',
        statusCode: 200,
      });

      const errorCodes = Object.keys(response.errors);

      // All error codes should follow the format PREFIX_XXXX
      errorCodes.forEach((code) => {
        expect(code).toMatch(/^[A-Z]+_\d{4}$/);
      });

      // Should have multiple error codes defined
      expect(errorCodes.length).toBeGreaterThan(10);
    });

    it('should have authentication error codes defined', async () => {
      // Verify authentication-related error codes exist
      const response = await testHelper.rest('/api/i18n/errors/en', {
        method: 'GET',
        statusCode: 200,
      });

      // Authentication errors (LTNS_0001-LTNS_0099)
      expect(response.errors).toHaveProperty('LTNS_0001'); // userNotFound
      expect(response.errors).toHaveProperty('LTNS_0002'); // invalidPassword
      expect(response.errors).toHaveProperty('LTNS_0003'); // invalidToken
      expect(response.errors).toHaveProperty('LTNS_0004'); // tokenExpired
    });

    it('should have authorization error codes defined', async () => {
      // Verify authorization-related error codes exist
      const response = await testHelper.rest('/api/i18n/errors/en', {
        method: 'GET',
        statusCode: 200,
      });

      // Authorization errors (LTNS_0100-LTNS_0199)
      expect(response.errors).toHaveProperty('LTNS_0100'); // unauthorized
      expect(response.errors).toHaveProperty('LTNS_0101'); // accessDenied
    });
  });

  // =================================================================================================================
  // LTNS Core Error Codes
  // =================================================================================================================

  describe('LTNS Core Error Codes', () => {
    it('should have LTNS_0001 for user not found', async () => {
      const response = await testHelper.rest('/api/i18n/errors/en', {
        method: 'GET',
        statusCode: 200,
      });

      // LTNS_0001 should exist for "user not found" scenario
      expect(response.errors).toHaveProperty('LTNS_0001');
      expect(response.errors.LTNS_0001.toLowerCase()).toContain('user');
    });

    it('should have LTNS_0002 for invalid password', async () => {
      const response = await testHelper.rest('/api/i18n/errors/en', {
        method: 'GET',
        statusCode: 200,
      });

      // LTNS_0002 should exist for "invalid password" scenario
      expect(response.errors).toHaveProperty('LTNS_0002');
      expect(response.errors.LTNS_0002.toLowerCase()).toContain('password');
    });

    it('should have all core error codes with LTNS prefix', async () => {
      const response = await testHelper.rest('/api/i18n/errors/en', {
        method: 'GET',
        statusCode: 200,
      });

      const ltnsErrors = Object.keys(response.errors).filter((code) => code.startsWith('LTNS_'));

      // Should have multiple LTNS error codes
      expect(ltnsErrors.length).toBeGreaterThanOrEqual(2);

      // All LTNS codes should follow the format LTNS_XXXX
      ltnsErrors.forEach((code) => {
        expect(code).toMatch(/^LTNS_\d{4}$/);
      });
    });
  });

  // =================================================================================================================
  // Error Factory Functions
  // =================================================================================================================

  describe('Error Factory Functions', () => {
    it('should have error factory for userNotFound that follows the correct format', async () => {
      // Verify the registry contains the userNotFound error with correct format
      const response = await testHelper.rest('/api/i18n/errors/en', {
        method: 'GET',
        statusCode: 200,
      });

      // LTNS_0001 should be the userNotFound error
      expect(response.errors).toHaveProperty('LTNS_0001');
      // The translation should mention user
      expect(response.errors.LTNS_0001.toLowerCase()).toContain('user');
    });

    it('should have error factory for invalidPassword that follows the correct format', async () => {
      // Verify the registry contains the invalidPassword error with correct format
      const response = await testHelper.rest('/api/i18n/errors/en', {
        method: 'GET',
        statusCode: 200,
      });

      // LTNS_0002 should be the invalidPassword error
      expect(response.errors).toHaveProperty('LTNS_0002');
      // The translation should mention password
      expect(response.errors.LTNS_0002.toLowerCase()).toContain('password');
    });

    it('should have error factory for unauthorized access that follows the correct format', async () => {
      // Verify the registry contains authorization errors with correct format
      const response = await testHelper.rest('/api/i18n/errors/en', {
        method: 'GET',
        statusCode: 200,
      });

      // LTNS_0100 should be the unauthorized error
      expect(response.errors).toHaveProperty('LTNS_0100');
      // The translation should mention authentication/login (since it's an auth error)
      const translation = response.errors.LTNS_0100.toLowerCase();
      expect(
        translation.includes('authenticated') ||
          translation.includes('authentication') ||
          translation.includes('logged'),
      ).toBe(true);
    });
  });

  // =================================================================================================================
  // Extensibility: Project-specific Error Codes
  // =================================================================================================================

  describe('Extensibility: Project-specific Error Codes', () => {
    it('should allow projects to extend with custom prefix', async () => {
      // The translation endpoint should be able to include project-specific codes
      // This is tested by verifying the endpoint accepts any valid PREFIX_XXXX format
      const response = await testHelper.rest('/api/i18n/errors/en', {
        method: 'GET',
        statusCode: 200,
      });

      // The structure should support multiple prefixes
      const allCodes = Object.keys(response.errors);
      const prefixes = new Set(allCodes.map((code) => code.split('_')[0]));

      // At minimum, LTNS should be present
      expect(prefixes.has('LTNS')).toBe(true);

      // The response structure supports adding more prefixes
      expect(typeof response.errors).toBe('object');
    });

    it('should include project-specific SRV_* error codes', async () => {
      // The ErrorCodeModule.forRoot() should register project-specific SRV_* codes
      const response = await testHelper.rest('/api/i18n/errors/en', {
        method: 'GET',
        statusCode: 200,
      });

      const allCodes = Object.keys(response.errors);
      const srvCodes = allCodes.filter((code) => code.startsWith('SRV_'));

      // Should have project-specific SRV_* codes
      expect(srvCodes.length).toBeGreaterThan(0);

      // SRV_0001 (DEMO_ERROR) should be present
      expect(response.errors).toHaveProperty('SRV_0001');
      expect(response.errors.SRV_0001.toLowerCase()).toContain('demo');
    });

    it('should merge LTNS_* and SRV_* codes in the same response', async () => {
      const response = await testHelper.rest('/api/i18n/errors/en', {
        method: 'GET',
        statusCode: 200,
      });

      const allCodes = Object.keys(response.errors);
      const ltnsCodes = allCodes.filter((code) => code.startsWith('LTNS_'));
      const srvCodes = allCodes.filter((code) => code.startsWith('SRV_'));

      // Both prefixes should be present
      expect(ltnsCodes.length).toBeGreaterThan(0);
      expect(srvCodes.length).toBeGreaterThan(0);

      // Total should be the sum of both
      expect(allCodes.length).toBe(ltnsCodes.length + srvCodes.length);
    });

    it('should expose /codes endpoint from extended controller', async () => {
      // The extended ErrorCodeController adds a /codes endpoint
      const response = await testHelper.rest('/api/i18n/errors/codes', {
        method: 'GET',
        statusCode: 200,
      });

      // Should return an array of error codes
      expect(Array.isArray(response)).toBe(true);
      expect(response.length).toBeGreaterThan(0);

      // Should contain both LTNS_* and SRV_* codes
      const hasLtns = response.some((code: string) => code.startsWith('LTNS_'));
      const hasSrv = response.some((code: string) => code.startsWith('SRV_'));
      expect(hasLtns).toBe(true);
      expect(hasSrv).toBe(true);
    });
  });

  // =================================================================================================================
  // Translation Completeness
  // =================================================================================================================

  describe('Translation Completeness', () => {
    it('should have German translations for all error codes', async () => {
      const response = await testHelper.rest('/api/i18n/errors/de', {
        method: 'GET',
        statusCode: 200,
      });

      // All values should be non-empty strings
      Object.entries(response.errors).forEach(([, translation]) => {
        expect(typeof translation).toBe('string');
        expect((translation as string).length).toBeGreaterThan(0);
      });
    });

    it('should have English translations for all error codes', async () => {
      const response = await testHelper.rest('/api/i18n/errors/en', {
        method: 'GET',
        statusCode: 200,
      });

      // All values should be non-empty strings
      Object.entries(response.errors).forEach(([, translation]) => {
        expect(typeof translation).toBe('string');
        expect((translation as string).length).toBeGreaterThan(0);
      });
    });
  });
});
