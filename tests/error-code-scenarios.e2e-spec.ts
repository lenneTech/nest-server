/**
 * ErrorCode Module Extension Scenarios
 *
 * This test file verifies all extension scenarios for the ErrorCodeModule:
 *
 * | Scenario | Description | Configuration |
 * |----------|-------------|---------------|
 * | A | additionalErrorRegistry | Config-based, simplest |
 * | B | Custom Service | Service inheritance |
 * | C | Core Only | No extensions, default behavior |
 *
 * Each scenario is tested with its own NestJS application to ensure isolation.
 *
 * For the Full Module Override scenario (most complex), see:
 * - `tests/stories/error-code.story.test.ts`
 *
 * @see src/core/modules/error-code/INTEGRATION-CHECKLIST.md for detailed integration instructions
 */

import { INestApplication, Injectable, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CoreErrorCodeService,
  CoreModule,
  ErrorCodeModule,
  HttpExceptionLogFilter,
  IErrorRegistry,
  mergeErrorCodes,
  TestHelper,
} from '../src';

// =============================================================================
// Test Error Registries
// =============================================================================

/**
 * Test error registry for Scenario A (additionalErrorRegistry)
 */
const ScenarioAErrors = {
  TEST_ORDER_NOT_FOUND: {
    code: 'SCNA_0001',
    message: 'Order not found',
    translations: {
      de: 'Bestellung mit ID {orderId} wurde nicht gefunden.',
      en: 'Order with ID {orderId} was not found.',
    },
  },
  TEST_PAYMENT_FAILED: {
    code: 'SCNA_0002',
    message: 'Payment failed',
    translations: {
      de: 'Die Zahlung ist fehlgeschlagen: {reason}',
      en: 'Payment failed: {reason}',
    },
  },
} as const satisfies IErrorRegistry;

/**
 * Test error registry for Scenario B (Custom Service)
 */
const ScenarioBErrors = {
  CUSTOM_SERVICE_ERROR: {
    code: 'SCNB_0001',
    message: 'Custom service error',
    translations: {
      de: 'Benutzerdefinierter Service-Fehler aufgetreten.',
      en: 'Custom service error occurred.',
    },
  },
} as const satisfies IErrorRegistry;

// Merged error codes for type checking
export const ScenarioAErrorCodes = mergeErrorCodes(ScenarioAErrors);
export const ScenarioBErrorCodes = mergeErrorCodes(ScenarioBErrors);

// =============================================================================
// Custom Service for Scenario B
// =============================================================================

@Injectable()
class CustomErrorCodeService extends CoreErrorCodeService {
  constructor() {
    super();
    this.registerErrorRegistry(ScenarioBErrors);
  }
}

// =============================================================================
// Test Configuration
// =============================================================================

// Use unique database names for each scenario to avoid conflicts
// IAM-Only mode requires betterAuth configuration
const getTestConfig = (dbSuffix: string) => ({
  automaticObjectIdFiltering: true,
  // Enable BetterAuth for IAM-Only mode (required for CoreModule single-parameter signature)
  betterAuth: {
    autoRegister: true, // Auto-register BetterAuthModule
    basePath: '/iam',
    baseUrl: `http://localhost:${3100 + Math.floor(Math.random() * 100)}`,
    secret: 'TEST_BETTERAUTH_SECRET_32_CHARS_MIN',
  },
  env: 'test' as const,
  graphQl: {
    driver: {
      introspection: true,
    },
    maxComplexity: 1000,
  },
  jwt: {
    refresh: {
      renewal: true,
      secret: 'TEST_REFRESH_SECRET',
      signInOptions: { expiresIn: '7d' as const },
    },
    secret: 'TEST_SECRET',
    signInOptions: { expiresIn: '15m' as const },
  },
  mongoose: {
    uri: `mongodb://127.0.0.1/nest-server-${dbSuffix}`,
  },
  port: 0,
});

// =============================================================================
// Scenario A: additionalErrorRegistry (Config-based)
// =============================================================================

describe('Scenario A: additionalErrorRegistry', () => {
  let app: INestApplication;
  let testHelper: TestHelper;

  beforeAll(async () => {
    @Module({
      imports: [
        CoreModule.forRoot({
          ...getTestConfig('scenario-a'),
          errorCode: {
            additionalErrorRegistry: ScenarioAErrors,
          },
        }),
      ],
    })
    class TestModule {}

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    await app.init();
    testHelper = new TestHelper(app);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('should include core LTNS_* error codes', async () => {
    const response = await testHelper.rest('/api/i18n/errors/en', {
      method: 'GET',
      statusCode: 200,
    });

    const ltnsCodes = Object.keys(response.errors).filter((c) => c.startsWith('LTNS_'));
    expect(ltnsCodes.length).toBeGreaterThan(0);
    expect(response.errors).toHaveProperty('LTNS_0001'); // userNotFound
  });

  it('should include additional SCNA_* error codes from config', async () => {
    const response = await testHelper.rest('/api/i18n/errors/en', {
      method: 'GET',
      statusCode: 200,
    });

    const scnaCodes = Object.keys(response.errors).filter((c) => c.startsWith('SCNA_'));
    expect(scnaCodes.length).toBe(2);
    expect(response.errors).toHaveProperty('SCNA_0001');
    expect(response.errors).toHaveProperty('SCNA_0002');
  });

  it('should merge LTNS_* and SCNA_* codes correctly', async () => {
    const response = await testHelper.rest('/api/i18n/errors/en', {
      method: 'GET',
      statusCode: 200,
    });

    const allCodes = Object.keys(response.errors);
    const ltnsCodes = allCodes.filter((c) => c.startsWith('LTNS_'));
    const scnaCodes = allCodes.filter((c) => c.startsWith('SCNA_'));

    // Total should be sum of both
    expect(allCodes.length).toBe(ltnsCodes.length + scnaCodes.length);
  });

  it('should provide translations in both locales', async () => {
    const deResponse = await testHelper.rest('/api/i18n/errors/de', {
      method: 'GET',
      statusCode: 200,
    });
    const enResponse = await testHelper.rest('/api/i18n/errors/en', {
      method: 'GET',
      statusCode: 200,
    });

    // German translation
    expect(deResponse.errors.SCNA_0001).toContain('Bestellung');
    expect(deResponse.errors.SCNA_0002).toContain('Zahlung');

    // English translation
    expect(enResponse.errors.SCNA_0001).toContain('Order');
    expect(enResponse.errors.SCNA_0002).toContain('Payment');
  });

  it('should support placeholder format in additional errors', async () => {
    const response = await testHelper.rest('/api/i18n/errors/en', {
      method: 'GET',
      statusCode: 200,
    });

    // SCNA_0001 has {orderId} placeholder
    expect(response.errors.SCNA_0001).toContain('{orderId}');
    // SCNA_0002 has {reason} placeholder
    expect(response.errors.SCNA_0002).toContain('{reason}');
  });
});

// =============================================================================
// Scenario B: Custom Service
// =============================================================================

describe('Scenario B: Custom Service', () => {
  let app: INestApplication;
  let testHelper: TestHelper;

  beforeAll(async () => {
    @Module({
      imports: [
        CoreModule.forRoot({
          ...getTestConfig('scenario-b'),
          // Disable auto-register so we can register our own
          errorCode: {
            autoRegister: false,
          },
        }),
        // Register with custom service
        ErrorCodeModule.forRoot({
          service: CustomErrorCodeService,
        }),
      ],
    })
    class TestModule {}

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    await app.init();
    testHelper = new TestHelper(app);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('should include core LTNS_* error codes', async () => {
    const response = await testHelper.rest('/api/i18n/errors/en', {
      method: 'GET',
      statusCode: 200,
    });

    expect(response.errors).toHaveProperty('LTNS_0001');
  });

  it('should include custom service SCNB_* error codes', async () => {
    const response = await testHelper.rest('/api/i18n/errors/en', {
      method: 'GET',
      statusCode: 200,
    });

    expect(response.errors).toHaveProperty('SCNB_0001');
    expect(response.errors.SCNB_0001).toContain('Custom service error');
  });

  it('should merge LTNS_* and SCNB_* codes correctly', async () => {
    const response = await testHelper.rest('/api/i18n/errors/en', {
      method: 'GET',
      statusCode: 200,
    });

    const allCodes = Object.keys(response.errors);
    const ltnsCodes = allCodes.filter((c) => c.startsWith('LTNS_'));
    const scnbCodes = allCodes.filter((c) => c.startsWith('SCNB_'));

    expect(ltnsCodes.length).toBeGreaterThan(0);
    expect(scnbCodes.length).toBe(1);
  });
});

// =============================================================================
// Scenario C: Core Only (No Extensions)
// =============================================================================

describe('Scenario C: Core Only (No Extensions)', () => {
  let app: INestApplication;
  let testHelper: TestHelper;

  beforeAll(async () => {
    @Module({
      imports: [
        CoreModule.forRoot({
          ...getTestConfig('scenario-c'),
          // Default: no errorCode config, auto-register enabled
        }),
      ],
    })
    class TestModule {}

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    await app.init();
    testHelper = new TestHelper(app);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('should include only core LTNS_* error codes', async () => {
    const response = await testHelper.rest('/api/i18n/errors/en', {
      method: 'GET',
      statusCode: 200,
    });

    const allCodes = Object.keys(response.errors);

    // Only LTNS_* codes should be present
    allCodes.forEach((code) => {
      expect(code).toMatch(/^LTNS_\d{4}$/);
    });

    // No project codes
    const projectCodes = allCodes.filter((c) => !c.startsWith('LTNS_'));
    expect(projectCodes.length).toBe(0);
  });

  it('should have all core authentication error codes', async () => {
    const response = await testHelper.rest('/api/i18n/errors/en', {
      method: 'GET',
      statusCode: 200,
    });

    // Authentication errors
    expect(response.errors).toHaveProperty('LTNS_0001'); // userNotFound
    expect(response.errors).toHaveProperty('LTNS_0002'); // invalidPassword
    expect(response.errors).toHaveProperty('LTNS_0003'); // invalidToken
    expect(response.errors).toHaveProperty('LTNS_0004'); // tokenExpired
  });

  it('should have all core authorization error codes', async () => {
    const response = await testHelper.rest('/api/i18n/errors/en', {
      method: 'GET',
      statusCode: 200,
    });

    // Authorization errors
    expect(response.errors).toHaveProperty('LTNS_0100'); // unauthorized
    expect(response.errors).toHaveProperty('LTNS_0101'); // accessDenied
  });

  it('should provide translations in both locales', async () => {
    const deResponse = await testHelper.rest('/api/i18n/errors/de', {
      method: 'GET',
      statusCode: 200,
    });
    const enResponse = await testHelper.rest('/api/i18n/errors/en', {
      method: 'GET',
      statusCode: 200,
    });

    // Same codes in both locales
    const deCodes = Object.keys(deResponse.errors).sort();
    const enCodes = Object.keys(enResponse.errors).sort();
    expect(deCodes).toEqual(enCodes);

    // Different translations
    expect(deResponse.errors.LTNS_0001).not.toBe(enResponse.errors.LTNS_0001);
  });
});

// =============================================================================
// Type Safety Tests
// =============================================================================

describe('Type Safety: Error Code Factories', () => {
  it('should have type-safe error code access', () => {
    // Verify merged error codes are accessible
    expect(ScenarioAErrorCodes.TEST_ORDER_NOT_FOUND).toBe('#SCNA_0001: Order not found');
    expect(ScenarioAErrorCodes.TEST_PAYMENT_FAILED).toBe('#SCNA_0002: Payment failed');
    expect(ScenarioBErrorCodes.CUSTOM_SERVICE_ERROR).toBe('#SCNB_0001: Custom service error');
  });

  it('should follow #PREFIX_XXXX: Description format', () => {
    const errorCodePattern = /^#[A-Z]+_\d{4}: .+$/;

    expect(ScenarioAErrorCodes.TEST_ORDER_NOT_FOUND).toMatch(errorCodePattern);
    expect(ScenarioAErrorCodes.TEST_PAYMENT_FAILED).toMatch(errorCodePattern);
    expect(ScenarioBErrorCodes.CUSTOM_SERVICE_ERROR).toMatch(errorCodePattern);
  });
});
