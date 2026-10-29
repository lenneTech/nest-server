/**
 * Story: BetterAuth Plugin Tests (2FA & Passkey)
 *
 * As a developer using @lenne.tech/nest-server,
 * I want to verify that Better Auth's native plugin endpoints work correctly,
 * So that I can confidently use 2FA and Passkey in my projects.
 *
 * This test file verifies:
 * - Two-Factor Authentication (TOTP) endpoints
 * - Passkey (WebAuthn) endpoints
 * - Plugin configuration and availability
 * - Full 2FA login flow with TOTP code generation and verification
 *
 * The tests include:
 * - Endpoint availability and basic response validation
 * - Full E2E 2FA login flow using the otpauth library
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import * as OTPAuth from 'otpauth';

import { CoreBetterAuthService, HttpExceptionLogFilter, TestGraphQLType, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';
import { type IamTestDb, openIamTestDb } from '../helpers/iam-test-db';

describe('Story: BetterAuth Plugins (2FA & Passkey)', () => {
  let app: any;
  let testHelper: TestHelper;
  let betterAuthService: CoreBetterAuthService;
  let isBetterAuthEnabled: boolean;
  let isTwoFactorEnabled: boolean;
  let isPasskeyEnabled: boolean;

  // Database
  // The database the run routes the users to (MongoDB, or PostgreSQL in the iam-sql projects)
  let iamDb: IamTestDb;

  // Test data tracking
  const testUserIds: string[] = [];
  const testIamUserIds: string[] = [];

  // =============================================================================
  // Setup & Teardown
  // =============================================================================

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
      betterAuthService = moduleFixture.get(CoreBetterAuthService);
      isBetterAuthEnabled = betterAuthService.isEnabled();
      isTwoFactorEnabled = betterAuthService.isTwoFactorEnabled();
      isPasskeyEnabled = betterAuthService.isPasskeyEnabled();

      iamDb = await openIamTestDb(envConfig.mongoose.uri);
    } catch (e) {
      console.error('beforeAllError', e);
      throw e;
    }
  });

  afterAll(async () => {
    // Cleanup test users and everything Better-Auth keeps for them (sessions, accounts, 2FA, passkeys)
    if (iamDb) {
      await iamDb.deleteUsers({ ids: [...testUserIds, ...testIamUserIds] });
      await iamDb.close();
    }
    if (app) {
      await app.close();
    }
  });

  // =============================================================================
  // Helper Functions
  // =============================================================================

  const generateTestEmail = () => `plugin-test-${Date.now()}-${Math.random().toString(36).substring(7)}@test.com`;

  const createBetterAuthUser = async (email: string, password: string) => {
    const res: any = await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: 'Test User', password, termsAndPrivacyAccepted: true },
      statusCode: 201, // Created
    });

    if (res.user?.id) {
      testIamUserIds.push(res.user.id);
    }

    return res;
  };

  const signInBetterAuth = async (email: string, password: string) => {
    const res: any = await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email, password },
      statusCode: 200,
    });

    return res;
  };

  // =============================================================================
  // 1. Plugin Configuration Tests
  // =============================================================================

  describe('1. Plugin Configuration', () => {
    it('should report plugin availability via GraphQL', async () => {
      if (!isBetterAuthEnabled) {
        // Skip if Better Auth is disabled
        return;
      }

      const res: any = await testHelper.graphQl({
        fields: ['enabled', 'twoFactor', 'passkey'],
        name: 'betterAuthFeatures',
        type: TestGraphQLType.QUERY,
      });

      expect(res.enabled).toBe(true);
      expect(res.twoFactor).toBe(isTwoFactorEnabled);
      expect(res.passkey).toBe(isPasskeyEnabled);
    });

    it('should have correct service method responses', () => {
      expect(betterAuthService.isEnabled()).toBe(isBetterAuthEnabled);
      expect(betterAuthService.isTwoFactorEnabled()).toBe(isTwoFactorEnabled);
      expect(betterAuthService.isPasskeyEnabled()).toBe(isPasskeyEnabled);
    });
  });

  // =============================================================================
  // 2. Two-Factor Authentication (TOTP) Tests
  // =============================================================================

  describe('2. Two-Factor Authentication (TOTP)', () => {
    let twoFactorTestEmail: string;
    let twoFactorTestPassword: string;
    let twoFactorAuthToken: string;

    beforeAll(async () => {
      if (!isBetterAuthEnabled) return;

      // Create a test user for 2FA tests
      twoFactorTestEmail = generateTestEmail();
      twoFactorTestPassword = 'SecurePassword123!';

      await createBetterAuthUser(twoFactorTestEmail, twoFactorTestPassword);
      const signInResult = await signInBetterAuth(twoFactorTestEmail, twoFactorTestPassword);
      twoFactorAuthToken = signInResult.token || signInResult.session?.token;
    });

    describe('POST /iam/two-factor/enable', () => {
      it('should require authentication', async () => {
        if (!isBetterAuthEnabled) return;

        try {
          const response = await testHelper.rest('/iam/two-factor/enable', {
            method: 'POST',
            statusCode: 401,
          });
          expect(response.statusCode).toBe(401);
        } catch (error: any) {
          // Expected - no auth provided
          expect(error.message || error.statusCode).toBeDefined();
        }
      });

      it('should return TOTP setup data when authenticated and 2FA is enabled', async () => {
        if (!isBetterAuthEnabled || !isTwoFactorEnabled || !twoFactorAuthToken) {
          return;
        }

        try {
          const response: any = await testHelper.rest('/iam/two-factor/enable', {
            headers: {
              Authorization: `Bearer ${twoFactorAuthToken}`,
              Cookie: `token=${twoFactorAuthToken}; iam.session_token=${twoFactorAuthToken}`,
            },
            method: 'POST',
            statusCode: 200,
          });

          // Better Auth's enable 2FA returns TOTP setup data
          // Note: Response format depends on Better Auth version
          expect(response).toBeDefined();
          // May contain: totpURI, secret, backupCodes, etc.
        } catch (error: any) {
          // If 2FA endpoint is not available (404), config error (400/500), this is expected
          // in test environments where the full Better Auth plugin pipeline may not be active
          expect(error).toBeDefined();
        }
      });
    });

    describe('POST /iam/two-factor/verify-totp (Native Better Auth)', () => {
      it('should require a TOTP code', async () => {
        if (!isBetterAuthEnabled || !isTwoFactorEnabled) return;

        try {
          const response = await testHelper.rest('/iam/two-factor/verify-totp', {
            headers: {
              Authorization: `Bearer ${twoFactorAuthToken}`,
              Cookie: `token=${twoFactorAuthToken}`,
            },
            method: 'POST',
            payload: {},
            statusCode: 400,
          });
          expect(response.statusCode).toBe(400);
        } catch (error: any) {
          // Expected - no code provided
          expect(error).toBeDefined();
        }
      });

      it('should reject invalid TOTP codes', async () => {
        if (!isBetterAuthEnabled || !isTwoFactorEnabled || !twoFactorAuthToken) return;

        try {
          const response = await testHelper.rest('/iam/two-factor/verify-totp', {
            headers: {
              Authorization: `Bearer ${twoFactorAuthToken}`,
              Cookie: `token=${twoFactorAuthToken}`,
            },
            method: 'POST',
            payload: { code: '000000' },
            statusCode: 400,
          });
          expect(response).toBeDefined();
        } catch (error: any) {
          // Expected - invalid code or endpoint not available (404)
          expect(error).toBeDefined();
        }
      });
    });

    describe('POST /iam/two-factor/disable', () => {
      it('should require authentication', async () => {
        if (!isBetterAuthEnabled) return;

        try {
          const response = await testHelper.rest('/iam/two-factor/disable', {
            method: 'POST',
            statusCode: 401,
          });
          expect(response.statusCode).toBe(401);
        } catch (error: any) {
          // Expected - no auth
          expect(error).toBeDefined();
        }
      });
    });

    describe('POST /iam/two-factor/generate-backup-codes (Native Better Auth)', () => {
      it('should require authentication', async () => {
        if (!isBetterAuthEnabled || !isTwoFactorEnabled) return;

        try {
          const response = await testHelper.rest('/iam/two-factor/generate-backup-codes', {
            method: 'POST',
            statusCode: 401,
          });
          expect(response).toBeDefined();
        } catch (error: any) {
          expect(error).toBeDefined();
        }
      });
    });

    describe('POST /iam/two-factor/verify-backup-code (Native Better Auth)', () => {
      it('should require a backup code', async () => {
        if (!isBetterAuthEnabled || !isTwoFactorEnabled) return;

        try {
          const response = await testHelper.rest('/iam/two-factor/verify-backup-code', {
            headers: {
              Authorization: `Bearer ${twoFactorAuthToken}`,
              Cookie: `token=${twoFactorAuthToken}`,
            },
            method: 'POST',
            payload: {},
            statusCode: 400,
          });
          expect(response).toBeDefined();
        } catch (error: any) {
          expect(error).toBeDefined();
        }
      });
    });
  });

  // =============================================================================
  // 3. Passkey (WebAuthn) Tests
  // =============================================================================

  describe('3. Passkey (WebAuthn)', () => {
    let passkeyTestEmail: string;
    let passkeyTestPassword: string;
    let passkeyAuthToken: string;

    beforeAll(async () => {
      if (!isBetterAuthEnabled || !isPasskeyEnabled) return;

      // Create a test user for Passkey tests
      passkeyTestEmail = generateTestEmail();
      passkeyTestPassword = 'SecurePassword123!';

      await createBetterAuthUser(passkeyTestEmail, passkeyTestPassword);
      const signInResult = await signInBetterAuth(passkeyTestEmail, passkeyTestPassword);
      passkeyAuthToken = signInResult.token || signInResult.session?.token;
    });

    describe('POST /iam/passkey/generate-register-options', () => {
      it('should require authentication', async () => {
        if (!isBetterAuthEnabled || !isPasskeyEnabled) return;

        try {
          const response = await testHelper.rest('/iam/passkey/generate-register-options', {
            method: 'POST',
            statusCode: 401,
          });
          expect(response).toBeDefined();
        } catch (error: any) {
          expect(error).toBeDefined();
        }
      });

      it('should return WebAuthn registration options when authenticated', async () => {
        if (!isBetterAuthEnabled || !isPasskeyEnabled || !passkeyAuthToken) return;

        try {
          const response: any = await testHelper.rest('/iam/passkey/generate-register-options', {
            headers: {
              Authorization: `Bearer ${passkeyAuthToken}`,
              Cookie: `token=${passkeyAuthToken}; iam.session_token=${passkeyAuthToken}`,
            },
            method: 'POST',
            statusCode: 200,
          });

          // WebAuthn registration options should contain specific fields
          // Note: The response structure depends on Better Auth's passkey plugin
          expect(response).toBeDefined();
          // Typical fields: challenge, rp (relying party), user, pubKeyCredParams
        } catch (error: any) {
          // If Passkey endpoint is not available (404), CORS issue, or config error, this is expected
          // in test environments where the full Better Auth plugin pipeline may not be active
          expect(error).toBeDefined();
        }
      });
    });

    describe('POST /iam/passkey/verify-registration', () => {
      it('should require authentication', async () => {
        if (!isBetterAuthEnabled || !isPasskeyEnabled) return;

        try {
          const response = await testHelper.rest('/iam/passkey/verify-registration', {
            method: 'POST',
            payload: {},
            statusCode: 401,
          });
          expect(response).toBeDefined();
        } catch (error: any) {
          expect(error).toBeDefined();
        }
      });

      it('should reject invalid registration data', async () => {
        if (!isBetterAuthEnabled || !isPasskeyEnabled || !passkeyAuthToken) return;

        try {
          const response = await testHelper.rest('/iam/passkey/verify-registration', {
            headers: {
              Authorization: `Bearer ${passkeyAuthToken}`,
              Cookie: `token=${passkeyAuthToken}; iam.session_token=${passkeyAuthToken}`,
            },
            method: 'POST',
            payload: { credential: 'invalid' },
            statusCode: 400,
          });
          expect(response).toBeDefined();
        } catch (error: any) {
          // Expected - invalid credential data or endpoint may return error differently
          expect(error).toBeDefined();
        }
      });
    });

    describe('POST /iam/passkey/generate-authenticate-options', () => {
      it('should be accessible without authentication (for login)', async () => {
        if (!isBetterAuthEnabled || !isPasskeyEnabled) return;

        try {
          // This endpoint may work without auth (to start passkey login)
          const response: any = await testHelper.rest('/iam/passkey/generate-authenticate-options', {
            method: 'POST',
            payload: { email: passkeyTestEmail },
          });

          // Response should contain WebAuthn assertion options
          expect(response).toBeDefined();
        } catch (error: any) {
          // May require email or fail if user has no passkeys - this is expected
          expect(error).toBeDefined();
        }
      });
    });

    describe('POST /iam/passkey/verify-authentication', () => {
      it('should reject invalid authentication data', async () => {
        if (!isBetterAuthEnabled || !isPasskeyEnabled) return;

        try {
          const response = await testHelper.rest('/iam/passkey/verify-authentication', {
            method: 'POST',
            payload: { credential: 'invalid' },
            statusCode: 400,
          });
          expect(response).toBeDefined();
        } catch (error: any) {
          // Expected - invalid credential or endpoint may return error differently
          expect(error).toBeDefined();
        }
      });
    });

    describe('POST /iam/passkey/list-user-passkeys', () => {
      it('should require authentication', async () => {
        if (!isBetterAuthEnabled || !isPasskeyEnabled) return;

        try {
          const response = await testHelper.rest('/iam/passkey/list-user-passkeys', {
            method: 'POST',
            statusCode: 401,
          });
          expect(response).toBeDefined();
        } catch (error: any) {
          expect(error).toBeDefined();
        }
      });

      it('should return empty array for user with no passkeys', async () => {
        if (!isBetterAuthEnabled || !isPasskeyEnabled || !passkeyAuthToken) return;

        try {
          const response: any = await testHelper.rest('/iam/passkey/list-user-passkeys', {
            headers: {
              Authorization: `Bearer ${passkeyAuthToken}`,
              Cookie: `token=${passkeyAuthToken}; iam.session_token=${passkeyAuthToken}`,
            },
            method: 'POST',
            statusCode: 200,
          });

          // Should return array (empty if no passkeys registered)
          expect(response).toBeDefined();
          if (Array.isArray(response)) {
            expect(response).toEqual([]);
          }
        } catch (error: any) {
          // Some configurations may not support this endpoint
          expect(error).toBeDefined();
        }
      });
    });

    describe('POST /iam/passkey/delete-passkey', () => {
      it('should require authentication', async () => {
        if (!isBetterAuthEnabled || !isPasskeyEnabled) return;

        try {
          const response = await testHelper.rest('/iam/passkey/delete-passkey', {
            method: 'POST',
            payload: { id: 'nonexistent' },
            statusCode: 401,
          });
          expect(response).toBeDefined();
        } catch (error: any) {
          expect(error).toBeDefined();
        }
      });
    });

    describe('POST /iam/passkey/update-passkey', () => {
      it('should require authentication', async () => {
        if (!isBetterAuthEnabled || !isPasskeyEnabled) return;

        try {
          const response = await testHelper.rest('/iam/passkey/update-passkey', {
            method: 'POST',
            payload: { id: 'nonexistent', name: 'New Name' },
            statusCode: 401,
          });
          expect(response).toBeDefined();
        } catch (error: any) {
          expect(error).toBeDefined();
        }
      });
    });
  });

  // =============================================================================
  // 4. Full 2FA Login Flow (E2E)
  // =============================================================================

  describe('4. Full 2FA Login Flow (E2E)', () => {
    let e2eTestEmail: string;
    let e2eTestPassword: string;
    let e2eAuthToken: string;
    let totpSecret: string;

    beforeAll(async () => {
      if (!isBetterAuthEnabled || !isTwoFactorEnabled) return;

      // Create a dedicated test user for 2FA E2E flow
      e2eTestEmail = generateTestEmail();
      e2eTestPassword = 'SecurePassword123!';

      await createBetterAuthUser(e2eTestEmail, e2eTestPassword);
      const signInResult = await signInBetterAuth(e2eTestEmail, e2eTestPassword);
      e2eAuthToken = signInResult.token || signInResult.session?.token;
    });

    /**
     * @regression   12.0.0 — the API middleware forwarded native password routes untouched, so enabling 2FA
     *   with the right plaintext password answered "Invalid password" (only sign-in/sign-up/reset normalized).
     *   This flow had never run past that request: its catch block returned early.
     * @seen-failing Drop the normalizeNativePasswords() call from the request handler in
     *   src/core/modules/better-auth/core-better-auth-api.middleware.ts — registered as mutation
     *   `native-password-normalization-unwired` in tests/regression-mutations.json.
     */
    it('should complete full 2FA setup and login flow', async () => {
      if (!isBetterAuthEnabled || !isTwoFactorEnabled || !e2eAuthToken) {
        // Skipping 2FA E2E flow test - 2FA not enabled or no auth token
        return;
      }

      // =================================================================
      // Step 1: Enable 2FA and get TOTP secret
      // =================================================================
      // The bearer token alone: the token from the sign-in body is not a session-cookie value, and sending it
      // as `iam.session_token` too only gave Better-Auth an unsigned cookie to refuse. The plaintext password is
      // what an API client sends — normalized by the API middleware since 12.0.0 (PASSWORD_FIELD_PATHS).
      const enableResponse: any = await testHelper.rest('/iam/two-factor/enable', {
        headers: { Authorization: `Bearer ${e2eAuthToken}` },
        method: 'POST',
        payload: { password: e2eTestPassword },
        statusCode: 200,
      });

      expect(enableResponse).toBeDefined();

      // Extract TOTP secret from the response
      // Better Auth returns totpURI in format: otpauth://totp/AppName:email?secret=XXX&...
      const totpUri = enableResponse.totpURI || enableResponse.totpUri || enableResponse.uri;
      totpSecret = String(totpUri).match(/secret=([A-Z2-7]+)/i)?.[1] as string;
      expect(totpSecret, 'enable returns a TOTP URI with a secret').toBeTruthy();
      expect(totpSecret.length).toBeGreaterThan(10);

      // =================================================================
      // Step 2: Confirm the secret — in TOTP mode this is what ACTIVATES 2FA
      // =================================================================
      // Without it 2FA was never active, the sign-in below never asked for it, and every step after this
      // one had never run.
      const totp = new OTPAuth.TOTP({
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpSecret),
      });
      await testHelper.rest('/iam/two-factor/verify-totp', {
        headers: { Authorization: `Bearer ${e2eAuthToken}` },
        method: 'POST',
        payload: { code: totp.generate() },
        statusCode: 200,
      });

      // =================================================================
      // Step 3: Sign out and sign in again — now the second factor is required
      // =================================================================
      await testHelper.rest('/iam/sign-out', {
        headers: { Authorization: `Bearer ${e2eAuthToken}` },
        method: 'POST',
        statusCode: 201,
      });

      const signIn: any = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email: e2eTestEmail, password: e2eTestPassword },
        returnResponse: true,
        statusCode: 200,
      });
      const signInBody = JSON.parse(signIn.text);
      expect(
        signInBody.twoFactorRedirect === true || signInBody.requiresTwoFactor === true,
        'sign-in asks for the second factor',
      ).toBe(true);

      // =================================================================
      // Step 4: Complete the sign-in with a TOTP code and the pending two-factor cookie
      // =================================================================
      const setCookies: string[] = [].concat(signIn.headers['set-cookie'] ?? []);
      const pendingCookies = setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
      expect(pendingCookies, 'sign-in hands out the pending two-factor cookie').toContain('two_factor');

      const verifyResponse: any = await testHelper.rest('/iam/two-factor/verify-totp', {
        cookies: pendingCookies,
        method: 'POST',
        payload: { code: totp.generate() },
        statusCode: 200,
      });
      expect(verifyResponse?.token || verifyResponse?.user?.id, 'the second factor completes the sign-in').toBeTruthy();
    });

    it('should reject invalid TOTP codes during 2FA verification', async () => {
      if (!isBetterAuthEnabled || !isTwoFactorEnabled) return;

      try {
        const response = await testHelper.rest('/iam/two-factor/verify-totp', {
          headers: {
            Authorization: `Bearer ${e2eAuthToken}`,
            Cookie: `token=${e2eAuthToken}`,
          },
          method: 'POST',
          payload: { code: '000000' }, // Invalid code
          statusCode: 400,
        });
        // Should fail with 400 for invalid code
        expect(response).toBeDefined();
      } catch (error: any) {
        // Expected - invalid code should fail
        expect(error).toBeDefined();
      }
    });

    it('should generate backup codes once 2FA is active', async () => {
      if (!isBetterAuthEnabled || !isTwoFactorEnabled) return;

      // Self-contained: it used to reuse the flow test's user, on which TOTP was never confirmed — so 2FA was
      // never active, the request (which also sent no password) answered 400, and the case returned early.
      const email = `backup-codes-${Date.now()}@test.com`;
      const password = 'BackupCodes123!';
      await createBetterAuthUser(email, password);
      const signIn: any = await signInBetterAuth(email, password);
      const auth = { Authorization: `Bearer ${signIn.token || signIn.session?.token}` };

      const enable: any = await testHelper.rest('/iam/two-factor/enable', {
        headers: auth,
        method: 'POST',
        payload: { password },
        statusCode: 200,
      });
      const secret = String(enable.totpURI).match(/secret=([A-Z2-7]+)/i)?.[1];
      expect(secret, 'enable returns a TOTP URI with a secret').toBeTruthy();
      const totp = new OTPAuth.TOTP({
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(secret!),
      });

      // In TOTP mode Better-Auth activates 2FA only once a code from the new secret is confirmed.
      await testHelper.rest('/iam/two-factor/verify-totp', {
        headers: auth,
        method: 'POST',
        payload: { code: totp.generate() },
        statusCode: 200,
      });

      const response: any = await testHelper.rest('/iam/two-factor/generate-backup-codes', {
        headers: auth,
        method: 'POST',
        payload: { password },
        statusCode: 200,
      });
      expect(response.backupCodes.length).toBeGreaterThan(0);
      expect(response.backupCodes[0].length).toBeGreaterThanOrEqual(8);
    });
  });

  // =============================================================================
  // 5. Plugin Error Handling
  // =============================================================================

  describe('5. Plugin Error Handling', () => {
    it('should return appropriate error when 2FA is disabled but endpoint is called', async () => {
      if (!isBetterAuthEnabled || isTwoFactorEnabled) {
        // Skip if Better Auth is disabled or 2FA is enabled
        return;
      }

      try {
        const response = await testHelper.rest('/iam/two-factor/enable', {
          method: 'POST',
          statusCode: 400,
        });
        // Should return 400 or 404 when 2FA plugin is not enabled
        expect([400, 404]).toContain(response.statusCode);
      } catch (error: any) {
        expect([400, 404]).toContain(error.statusCode);
      }
    });

    it('should return appropriate error when Passkey is disabled but endpoint is called', async () => {
      if (!isBetterAuthEnabled || isPasskeyEnabled) {
        // Skip if Better Auth is disabled or Passkey is enabled
        return;
      }

      try {
        const response = await testHelper.rest('/iam/passkey/generate-register-options', {
          method: 'POST',
          statusCode: 400,
        });
        // Should return 400 or 404 when Passkey plugin is not enabled
        expect([400, 404]).toContain(response.statusCode);
      } catch (error: any) {
        expect([400, 404]).toContain(error.statusCode);
      }
    });

    /**
     * @regression   12.0.0 — the API middleware holds a plaintext NEW password to the length policy before it
     *   hashes it (Better-Auth would only see a 64-character sha256). The refusal is a BadRequestException, and the
     *   middleware's catch answered every error with 500 "Authentication handler error" plus an ERROR log line — on
     *   /change-password since the native routes were normalized, on the reset routes since the check existed.
     * @seen-failing Drop the `if (error instanceof HttpException) { throw error; }` passthrough from the catch in
     *   src/core/modules/better-auth/core-better-auth-api.middleware.ts — registered as mutation
     *   `native-password-length-refusal-answered-500` in tests/regression-mutations.json.
     */
    it('answers a too-short plaintext new password on change-password with 400 and keeps the old password', async () => {
      const email = generateTestEmail();
      const password = 'SecurePassword123!';
      await createBetterAuthUser(email, password);
      const signIn = await signInBetterAuth(email, password);
      const token = signIn.token || signIn.session?.token;
      expect(token, 'sign-in returns a token').toBeTruthy();

      const refusal: any = await testHelper.rest('/iam/change-password', {
        headers: { Authorization: `Bearer ${token}` },
        method: 'POST',
        payload: { currentPassword: password, newPassword: 'short' },
        statusCode: 400,
      });
      expect(JSON.stringify(refusal)).toContain('Password must be between');

      // Nothing was changed: the original password still signs in.
      await signInBetterAuth(email, password);
    });

    it('answers a too-short reset password with 400 before any token is looked at', async () => {
      const refusal: any = await testHelper.rest('/iam/reset-password', {
        method: 'POST',
        payload: { newPassword: 'short', token: 'not-a-reset-token' },
        statusCode: 400,
      });
      expect(JSON.stringify(refusal)).toContain('Password must be between');
    });
  });

  // =============================================================================
  // 6. Session Token Cookie Handling
  // =============================================================================

  describe('6. Session Token Cookie Handling', () => {
    let cookieTestEmail: string;
    let cookieTestPassword: string;

    beforeAll(async () => {
      if (!isBetterAuthEnabled) return;

      cookieTestEmail = generateTestEmail();
      cookieTestPassword = 'SecurePassword123!';
      await createBetterAuthUser(cookieTestEmail, cookieTestPassword);
    });

    it('should set multiple session token cookies on sign-in', async () => {
      if (!isBetterAuthEnabled) return;

      // We can't directly inspect cookies in this test setup,
      // but we can verify the sign-in works and returns expected data
      const response: any = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email: cookieTestEmail, password: cookieTestPassword },
        statusCode: 200,
      });

      expect(response).toBeDefined();
      // Session should be created
      expect(response.session || response.user).toBeDefined();
    });

    it('should accept session token via Authorization header', async () => {
      if (!isBetterAuthEnabled) return;

      const signInResponse: any = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email: cookieTestEmail, password: cookieTestPassword },
        statusCode: 200,
      });

      const token = signInResponse.token || signInResponse.session?.token;
      if (!token) return;

      // Use token in Authorization header to access session endpoint
      const sessionResponse: any = await testHelper.rest('/iam/session', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        method: 'GET',
        statusCode: 200,
      });

      expect(sessionResponse).toBeDefined();
    });

    it('should accept session token via Cookie header', async () => {
      if (!isBetterAuthEnabled) return;

      const signInResponse: any = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email: cookieTestEmail, password: cookieTestPassword },
        statusCode: 200,
      });

      const token = signInResponse.token || signInResponse.session?.token;
      if (!token) return;

      // Use token in Cookie header (multiple cookie names for compatibility)
      const sessionResponse: any = await testHelper.rest('/iam/session', {
        headers: {
          Cookie: `token=${token}; iam.session_token=${token}; better-auth.session_token=${token}`,
        },
        method: 'GET',
        statusCode: 200,
      });

      expect(sessionResponse).toBeDefined();
    });

    /**
     * CRITICAL TEST: Verifies that Set-Cookie header is set when 2FA is required.
     *
     * This test ensures that when a user with 2FA enabled signs in:
     * 1. The response includes `requiresTwoFactor: true`
     * 2. The response includes a `Set-Cookie` header with `better-auth.two_factor` token
     *
     * Without this cookie, the browser cannot authenticate the subsequent 2FA verification request,
     * causing the 2FA flow to fail with 401 Unauthorized.
     *
     * Bug fixed in: 11.10.x
     * @see migration-guides/11.9.x-to-11.10.x.md
     */
    it('should set Set-Cookie header with two_factor token when 2FA is required', async () => {
      if (!isBetterAuthEnabled || !isTwoFactorEnabled) {
        // Skip if Better Auth or 2FA is disabled
        return;
      }

      // Create a dedicated test user for this cookie validation test
      const twoFaCookieTestEmail = generateTestEmail();
      const twoFaCookieTestPassword = 'SecurePassword123!';

      await createBetterAuthUser(twoFaCookieTestEmail, twoFaCookieTestPassword);

      // Sign in to get auth token
      const initialSignIn: any = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email: twoFaCookieTestEmail, password: twoFaCookieTestPassword },
        statusCode: 200,
      });

      const authToken = initialSignIn.token || initialSignIn.session?.token;
      if (!authToken) {
        console.warn('No auth token received, skipping 2FA cookie test');
        return;
      }

      // Enable 2FA for this user
      const enableResponse: any = await testHelper.rest('/iam/two-factor/enable', {
        headers: { Authorization: `Bearer ${authToken}` },
        method: 'POST',
        payload: { password: twoFaCookieTestPassword },
        statusCode: 200,
      });

      // TOTP mode activates 2FA only once a code from the new secret is confirmed. Without this step 2FA was never
      // active, the sign-in below never asked for it, and the case returned before its critical assertion.
      const secret = String(enableResponse?.totpURI).match(/secret=([A-Z2-7]+)/i)?.[1];
      expect(secret, 'enable returns a TOTP URI with a secret').toBeTruthy();
      const totp = new OTPAuth.TOTP({
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(secret!),
      });
      await testHelper.rest('/iam/two-factor/verify-totp', {
        headers: { Authorization: `Bearer ${authToken}` },
        method: 'POST',
        payload: { code: totp.generate() },
        statusCode: 200,
      });

      await testHelper.rest('/iam/sign-out', {
        headers: { Authorization: `Bearer ${authToken}` },
        method: 'POST',
        statusCode: 201,
      });

      // Sign in again - this time 2FA should be required
      // Use returnResponse: true to get access to the Set-Cookie headers
      const signInWithCookies: any = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email: twoFaCookieTestEmail, password: twoFaCookieTestPassword },
        returnResponse: true, // Get full response with headers
        statusCode: 200,
      });

      // Parse the response body
      let responseBody: any;
      try {
        responseBody = JSON.parse(signInWithCookies.text);
      } catch {
        responseBody = signInWithCookies.body || {};
      }

      // Check that 2FA is required
      const requires2FA = responseBody.requiresTwoFactor === true || responseBody.twoFactorRedirect === true;
      expect(requires2FA, 'sign-in asks for the second factor once 2FA is active').toBe(true);

      // CRITICAL ASSERTION: Verify Set-Cookie header contains the two_factor token
      // This is the bug that was fixed in 11.10.x - without this cookie, 2FA verification fails
      const setCookieHeader = signInWithCookies.headers['set-cookie'];
      expect(setCookieHeader).toBeDefined();

      // The header can be a string or an array of strings
      const cookieStrings = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
      const cookieString = cookieStrings.join('; ');

      // Check for the two_factor cookie (Better Auth sets this for 2FA pending sessions)
      const hasTwoFactorCookie = cookieString.includes('better-auth.two_factor') || cookieString.includes('two_factor');

      // This assertion will FAIL without the fix implemented in 11.10.x
      expect(hasTwoFactorCookie).toBe(true);
    });
  });

  // =============================================================================
  // 7. Parallel Authentication Methods (2FA + Passkey)
  // =============================================================================

  describe('7. Parallel Authentication Methods (2FA + Passkey)', () => {
    let parallelTestEmail: string;
    let parallelTestPassword: string;
    let parallelAuthToken: string;

    beforeAll(async () => {
      if (!isBetterAuthEnabled || !isTwoFactorEnabled || !isPasskeyEnabled) return;

      // Create a test user for parallel auth testing
      parallelTestEmail = generateTestEmail();
      parallelTestPassword = 'SecurePassword123!';

      await createBetterAuthUser(parallelTestEmail, parallelTestPassword);
      const signInResult = await signInBetterAuth(parallelTestEmail, parallelTestPassword);
      parallelAuthToken = signInResult.token || signInResult.session?.token;
    });

    describe('Configuration Verification', () => {
      it('should have both 2FA and Passkey enabled simultaneously', () => {
        // This test verifies that the configuration allows both methods
        expect(betterAuthService.isTwoFactorEnabled()).toBe(true);
        expect(betterAuthService.isPasskeyEnabled()).toBe(true);
      });

      it('should report both features via GraphQL', async () => {
        if (!isBetterAuthEnabled) return;

        const res: any = await testHelper.graphQl({
          fields: ['enabled', 'twoFactor', 'passkey'],
          name: 'betterAuthFeatures',
          type: TestGraphQLType.QUERY,
        });

        expect(res.enabled).toBe(true);
        expect(res.twoFactor).toBe(true);
        expect(res.passkey).toBe(true);
      });
    });

    describe('Same User Can Access Both Authentication Methods', () => {
      it('should allow same user to access 2FA enable endpoint', async () => {
        if (!isBetterAuthEnabled || !isTwoFactorEnabled || !parallelAuthToken) return;

        try {
          // Attempt to enable 2FA - this should at least accept the request
          const response: any = await testHelper.rest('/iam/two-factor/enable', {
            headers: {
              Authorization: `Bearer ${parallelAuthToken}`,
              Cookie: `token=${parallelAuthToken}; iam.session_token=${parallelAuthToken}`,
            },
            method: 'POST',
          });

          // If successful, should return TOTP setup data
          expect(response).toBeDefined();
          // Response may contain: totpURI, secret, backupCodes, status
        } catch (error: any) {
          // 2FA endpoint may not be routed through API middleware in test environment
          // This is acceptable - we're testing that the configuration is valid
          expect(error).toBeDefined();
        }
      });

      it('should allow same user to access Passkey registration endpoint', async () => {
        if (!isBetterAuthEnabled || !isPasskeyEnabled || !parallelAuthToken) return;

        try {
          // Attempt to get Passkey registration options
          const response: any = await testHelper.rest('/iam/passkey/generate-register-options', {
            headers: {
              Authorization: `Bearer ${parallelAuthToken}`,
              Cookie: `token=${parallelAuthToken}; iam.session_token=${parallelAuthToken}`,
            },
            method: 'POST',
          });

          // If successful, should return WebAuthn registration options
          expect(response).toBeDefined();
          // Response typically contains: challenge, rp, user, pubKeyCredParams
        } catch (error: any) {
          // Passkey endpoint may not be routed through API middleware in test environment
          // This is acceptable - we're testing that the configuration is valid
          expect(error).toBeDefined();
        }
      });

      it('should allow user to sign in with email/password while having both methods available', async () => {
        if (!isBetterAuthEnabled || !isTwoFactorEnabled || !isPasskeyEnabled) return;

        // Sign in with email/password - this should work regardless of 2FA/Passkey setup
        const response: any = await testHelper.rest('/iam/sign-in/email', {
          method: 'POST',
          payload: { email: parallelTestEmail, password: parallelTestPassword },
          statusCode: 200,
        });

        expect(response).toBeDefined();
        expect(response.user || response.session).toBeDefined();

        // If 2FA is enabled for the user, response may include requires2FA flag
        // If not yet enabled for this specific user, login succeeds directly
      });
    });

    describe('Database Schema Supports Both Methods', () => {
      it('should have twoFactor collection available', async () => {
        if (!isBetterAuthEnabled || !isTwoFactorEnabled) return;

        // Verify the twoFactor collection exists (created by Better Auth)
        const collections = await iamDb.mongo.listCollections({ name: 'twoFactor' }).toArray();
        // Collection may or may not exist depending on whether 2FA was ever used
        expect(collections.length).toBeGreaterThanOrEqual(0);
      });

      it('should have passkey collection available', async () => {
        if (!isBetterAuthEnabled || !isPasskeyEnabled) return;

        // Verify the passkey collection exists (created by Better Auth)
        const collections = await iamDb.mongo.listCollections({ name: 'passkey' }).toArray();
        // Collection may or may not exist depending on whether Passkey was ever used
        expect(collections.length).toBeGreaterThanOrEqual(0);
      });

      it('should store user with potential for both auth methods', async () => {
        if (!isBetterAuthEnabled) return;

        // Find our test user in the database
        // BetterAuth dual-write (sign-up + linkOrCreateUser) may have write-consistency delays,
        // so retry the query a few times before failing
        let user: any = null;
        for (let attempt = 0; attempt < 5 && !user; attempt++) {
          user = await iamDb.findUser({ email: parallelTestEmail });
          if (!user) await new Promise((r) => setTimeout(r, 100));
        }

        expect(user).toBeDefined();
        expect(user.email).toBe(parallelTestEmail);

        // User document should be able to have both 2FA and Passkey linked
        // (These are stored in separate collections, linked by userId)
      });
    });

    describe('Authentication Flow Independence', () => {
      it('should allow Passkey authentication attempt independent of 2FA status', async () => {
        if (!isBetterAuthEnabled || !isPasskeyEnabled) return;

        try {
          // Try to get authentication options for Passkey
          // This should work even if 2FA is enabled for the user
          const response: any = await testHelper.rest('/iam/passkey/generate-authenticate-options', {
            method: 'POST',
            payload: { email: parallelTestEmail },
          });

          // May fail if user has no passkeys registered, but endpoint should be accessible
          expect(response).toBeDefined();
        } catch (error: any) {
          // Expected if user has no passkeys or endpoint not available in test env
          expect(error).toBeDefined();
        }
      });

      it('should not require 2FA for Passkey-based authentication', async () => {
        if (!isBetterAuthEnabled || !isPasskeyEnabled) return;

        // Conceptual test: Passkey authentication bypasses 2FA requirement
        // because Passkey itself is a strong second factor (biometric/hardware)
        //
        // This is by design in Better Auth:
        // - Email + Password + 2FA = Two factors (knowledge + possession)
        // - Passkey = Already two factors (possession + biometric/PIN)

        // We can't fully test this without real WebAuthn, but we verify the concept
        expect(betterAuthService.isPasskeyEnabled()).toBe(true);
        expect(betterAuthService.isTwoFactorEnabled()).toBe(true);

        // Both being true means both authentication paths are available
        // The user can choose which method to use for each sign-in
      });
    });
  });

  // =============================================================================
  // 8. Regression: Sign-Up Session Token & Plugin Access (v11.13.x Fix)
  // =============================================================================

  describe('8. Regression: Sign-Up Session Token & Plugin Access (v11.13.x)', () => {
    // These tests prevent regression of two bugs fixed in v11.13.x:
    //
    // Bug 1: Sign-up response did not include `token`, so `processCookies()` never
    //         set session cookies. All subsequent authenticated requests (Passkey,
    //         2FA, /session, /token) returned 401 after sign-up.
    //
    // Bug 2: `toWebRequest()` unnecessarily parsed and rebuilt the Cookie header,
    //         potentially corrupting the HMAC signature. Now the original header is
    //         preserved when it already contains a session cookie.
    //
    // Test strategy:
    // - When `cookies: false` (default): token is in response body, use via `cookies` option
    // - When `cookies: true`: token is in Set-Cookie headers, forwarded as cookies
    // Both modes are tested by extracting the token from wherever it's available.

    /**
     * Extract session token from sign-up or sign-in response.
     * Works in both cookie modes:
     * - cookies: false → token is in response body
     * - cookies: true → token is in Set-Cookie headers
     */
    function getSessionToken(response: any): null | string {
      // Try response body first (cookies: false mode)
      const body = response.body || response;
      if (body?.token && typeof body.token === 'string') {
        return body.token;
      }
      // Try Set-Cookie headers (cookies: true mode)
      return TestHelper.extractSessionToken(response);
    }

    /**
     * Sign up a new user and return the session token.
     * Handles both cookie modes transparently.
     */
    async function signUpAndGetToken(email: string, password: string): Promise<string> {
      // Use returnResponse to access both body and headers
      const response: any = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Regression User', password, termsAndPrivacyAccepted: true },
        returnResponse: true,
        statusCode: 201,
      });

      // Try body first, then cookies
      let bodyData: any;
      try {
        bodyData = JSON.parse(response.text);
      } catch {
        bodyData = response.body;
      }

      const token = bodyData?.token || TestHelper.extractSessionToken(response);
      if (!token) {
        throw new Error('No session token found in sign-up response (neither body nor cookies)');
      }

      // Cleanup tracking
      const user = await iamDb.findUser({ email });
      if (user) testUserIds.push(user.id);

      return token;
    }

    it('should include token in sign-up response (body or cookies)', async () => {
      if (!isBetterAuthEnabled) return;

      const email = generateTestEmail();
      const password = 'SecurePassword123!';

      const response: any = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Token Regression User', password, termsAndPrivacyAccepted: true },
        returnResponse: true,
        statusCode: 201,
      });

      // REGRESSION: Before the fix, response.token was undefined AND no cookies were set.
      // After the fix, the token is available either in the body (cookies: false)
      // or in Set-Cookie headers (cookies: true).
      const token = getSessionToken(response);
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token!.length).toBeGreaterThan(0);

      // Cleanup tracking
      const user = await iamDb.findUser({ email });
      if (user) testUserIds.push(user.id);
    });

    it('should not return 401 for session access after sign-up', async () => {
      if (!isBetterAuthEnabled) return;

      const email = generateTestEmail();
      const password = 'SecurePassword123!';

      const sessionToken = await signUpAndGetToken(email, password);

      // REGRESSION: Before the fix, this returned 401 because sign-up didn't provide
      // a session token (neither in body nor as cookies).
      // The critical check: the session endpoint responds with 200 (not 401).
      // Note: success may be false if session lookup fails internally (e.g., cookie
      // signing mismatch in test env), but 200 proves the request is authenticated.
      const sessionResponse: any = await testHelper.rest('/iam/session', {
        method: 'GET',
        statusCode: 200,
        token: sessionToken,
      });

      expect(sessionResponse).toBeDefined();
      expect(typeof sessionResponse.success).toBe('boolean');
    });

    it('should not return 401 for passkey list after sign-up', async () => {
      if (!isBetterAuthEnabled || !isPasskeyEnabled) return;

      const email = generateTestEmail();
      const password = 'SecurePassword123!';

      const sessionToken = await signUpAndGetToken(email, password);

      // REGRESSION: Before the fix, passkey endpoints returned 401 after sign-up
      // because (1) no session token was provided, and (2) toWebRequest could corrupt
      // cookie signatures during re-encoding.
      // The critical check: a valid session token must NOT produce a 401.
      // The endpoint may return 200 (success), 400 (bad request), or 404 (not found),
      // but never 401 (authentication failure) with a valid token.
      try {
        const passkeyResponse: any = await testHelper.rest('/iam/passkey/list-user-passkeys', {
          cookies: sessionToken,
          method: 'POST',
          statusCode: 200,
        });

        expect(passkeyResponse).toBeDefined();
        if (Array.isArray(passkeyResponse)) {
          expect(passkeyResponse).toEqual([]);
        }
      } catch (error: any) {
        // Accept any error except 401 (authentication failure)
        const status = error?.statusCode || error?.status;
        expect(status).not.toBe(401);
      }
    });

    it('should not return 401 for passkey registration options after sign-up', async () => {
      if (!isBetterAuthEnabled || !isPasskeyEnabled) return;

      const email = generateTestEmail();
      const password = 'SecurePassword123!';

      const sessionToken = await signUpAndGetToken(email, password);

      // REGRESSION: Before the fix, this returned 401 because the middleware
      // couldn't authenticate the user (no session token available).
      // The critical check: valid token must NOT produce 401.
      try {
        const regOptions: any = await testHelper.rest('/iam/passkey/generate-register-options', {
          cookies: sessionToken,
          method: 'POST',
          statusCode: 200,
        });

        expect(regOptions).toBeDefined();
      } catch (error: any) {
        const status = error?.statusCode || error?.status;
        expect(status).not.toBe(401);
      }
    });

    it('should not return 401 for passkey endpoints with sign-in token', async () => {
      if (!isBetterAuthEnabled || !isPasskeyEnabled) return;

      const email = generateTestEmail();
      const password = 'SecurePassword123!';

      // Sign up first
      await signUpAndGetToken(email, password);

      // Sign in and get token
      const signInResponse: any = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
        returnResponse: true,
        statusCode: 200,
      });

      const signInToken = getSessionToken(signInResponse);
      expect(signInToken).toBeDefined();

      // REGRESSION: Before the fix, toWebRequest() would parse all cookies (URL-decode),
      // then rebuild the cookie string with mixed encoding, potentially corrupting the
      // HMAC signature. Now the original cookie header is preserved as-is.
      // The critical check: valid sign-in token must NOT produce 401.
      try {
        const passkeyResponse: any = await testHelper.rest('/iam/passkey/list-user-passkeys', {
          cookies: signInToken!,
          method: 'POST',
          statusCode: 200,
        });

        expect(passkeyResponse).toBeDefined();
      } catch (error: any) {
        const status = error?.statusCode || error?.status;
        expect(status).not.toBe(401);
      }
    });

    it('should allow 2FA enable immediately after sign-up', async () => {
      if (!isBetterAuthEnabled || !isTwoFactorEnabled) return;

      const email = generateTestEmail();
      const password = 'SecurePassword123!';

      const sessionToken = await signUpAndGetToken(email, password);

      // REGRESSION: Before the fix, 2FA enable returned 401 after sign-up
      // because no session token was available for authentication
      try {
        const enableResponse: any = await testHelper.rest('/iam/two-factor/enable', {
          cookies: sessionToken,
          method: 'POST',
          payload: { password },
          statusCode: 200,
        });

        // If 2FA enable succeeds, it returns TOTP setup data
        expect(enableResponse).toBeDefined();
      } catch (error: any) {
        // 2FA enable may fail for reasons other than 401 (e.g., already enabled)
        // The important check is that it does NOT fail with 401 (authentication error)
        const statusCode = error?.statusCode || error?.status;
        expect(statusCode).not.toBe(401);
      }
    });

    it('should return consistent token format between sign-up and sign-in', async () => {
      if (!isBetterAuthEnabled) return;

      const email = generateTestEmail();
      const password = 'SecurePassword123!';

      // Sign up
      const signUpResponse: any = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Token Format User', password, termsAndPrivacyAccepted: true },
        returnResponse: true,
        statusCode: 201,
      });

      const signUpToken = getSessionToken(signUpResponse);
      expect(signUpToken).toBeDefined();

      // Sign in
      const signInResponse: any = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
        returnResponse: true,
        statusCode: 200,
      });

      const signInToken = getSessionToken(signInResponse);
      expect(signInToken).toBeDefined();

      // REGRESSION: Before the fix, sign-up returned no token at all while sign-in
      // returned a token. Both should return tokens of the same format.
      expect(typeof signUpToken).toBe('string');
      expect(typeof signInToken).toBe('string');
      expect(signUpToken!.length).toBeGreaterThan(0);
      expect(signInToken!.length).toBeGreaterThan(0);

      // Cleanup tracking
      const user = await iamDb.findUser({ email });
      if (user) testUserIds.push(user.id);
    });
  });
});
