/**
 * Story: Cookie Security Property — Token MUST NOT be in response body when cookies-only mode
 *
 * SCOPE: Verifies the central security property of v11.25.0 cookie mode:
 * When `cookies: true` (default) WITHOUT `exposeTokenInBody`, the session token
 * must be delivered ONLY via httpOnly cookie — never in the response body.
 *
 * This is the property that justifies the cookies-default-true breaking change:
 * the httpOnly cookie is immune to XSS (JavaScript cannot read it), while a token
 * in the response body would negate that protection (XSS scripts can read it).
 *
 * Covers:
 * - Legacy Auth signIn/signUp (GraphQL + REST)
 * - BetterAuth IAM sign-in/sign-up (REST) — validates both cookie-only (default)
 *   and hybrid mode (exposeTokenInBody: true)
 *
 * Configuration: Overrides `cookies` to `true` via `ConfigService.setProperty()`
 * and restores the original e2e value in afterAll.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConfigService, HttpExceptionLogFilter, TestGraphQLType, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';

describe('Story: Cookie Security Property (token-not-in-body)', () => {
  let app: any;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;
  let originalCookiesConfig: unknown;

  const testEmails: string[] = [];
  const makeEmail = (prefix: string): string => {
    const email = `cookie-sec-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
    testEmails.push(email);
    return email;
  };

  beforeAll(async () => {
    // Snapshot original cookies config (e2e default: { exposeTokenInBody: true })
    originalCookiesConfig = ConfigService.configFastButReadOnly?.cookies;

    // Force cookies-only mode: token MUST NOT end up in the response body.
    // setProperty performs direct assignment (not lodash merge) so the scalar
    // `true` fully replaces `{ exposeTokenInBody: true }`.
    ConfigService.setProperty('cookies', true);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    app.setBaseViewsDir(envConfig.templates.path);
    app.setViewEngine(envConfig.templates.engine);
    await app.init();
    testHelper = new TestHelper(app);

    mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
    db = mongoClient.db();
  });

  afterAll(async () => {
    // Restore original cookies config. Direct assignment via setProperty — mergeProperty
    // would incorrectly collapse `{ exposeTokenInBody: true }` when merged onto primitive `true`.
    ConfigService.setProperty('cookies', originalCookiesConfig);

    if (db) {
      for (const email of testEmails) {
        const user = await db.collection('users').findOne({ email });
        if (user) {
          await db.collection('account').deleteMany({ userId: user._id });
          await db.collection('session').deleteMany({ userId: user._id });
          await db.collection('users').deleteOne({ email });
        }
      }
    }
    if (mongoClient) await mongoClient.close();
    if (app) await app.close();
  });

  // ===================================================================================================================
  // Legacy Auth — GraphQL signIn/signUp
  // ===================================================================================================================

  describe('Legacy Auth GraphQL', () => {
    it('signUp response MUST NOT contain token/refreshToken when cookies:true (no exposeTokenInBody)', async () => {
      const email = makeEmail('gql-signup');
      const result = await testHelper.graphQl({
        arguments: { input: { email, password: 'SecurePass123!' } },
        fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // CRITICAL security assertion: token MUST be absent from body
      expect(result.token).toBeFalsy();
      expect(result.refreshToken).toBeFalsy();
      // But signUp itself succeeded — user object is present
      expect(result.user?.email).toBe(email);
    });

    it('signIn response MUST NOT contain token/refreshToken when cookies:true (no exposeTokenInBody)', async () => {
      const email = makeEmail('gql-signin');

      // Prerequisite: create user (response also has no token — by design)
      await testHelper.graphQl({
        arguments: { input: { email, password: 'SecurePass123!' } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      const result = await testHelper.graphQl({
        arguments: { input: { email, password: 'SecurePass123!' } },
        fields: ['token', 'refreshToken'],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      expect(result.token).toBeFalsy();
      expect(result.refreshToken).toBeFalsy();
    });
  });

  // ===================================================================================================================
  // Legacy Auth — REST signIn/signUp (cookie header inspection)
  // ===================================================================================================================

  describe('Legacy Auth REST', () => {
    it('POST /auth/signin MUST set httpOnly Set-Cookie AND strip token from body', async () => {
      const email = makeEmail('rest-signin');

      // Create user first via GraphQL
      await testHelper.graphQl({
        arguments: { input: { email, password: 'SecurePass123!' } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      const response = await testHelper.rest('/auth/signin', {
        method: 'POST',
        payload: { email, password: 'SecurePass123!' },
        returnResponse: true,
        statusCode: 201,
      });

      // Body: no token / refreshToken
      expect(response.body.token).toBeFalsy();
      expect(response.body.refreshToken).toBeFalsy();

      // Set-Cookie: `token` and `refreshToken` cookies MUST be present
      const cookies = TestHelper.extractCookies(response);
      expect(cookies.token).toBeDefined();
      expect(cookies.token.length).toBeGreaterThan(0);
      expect(cookies.refreshToken).toBeDefined();
      expect(cookies.refreshToken.length).toBeGreaterThan(0);

      // httpOnly / sameSite / secure flags (raw Set-Cookie headers)
      const setCookieRaw = response.headers['set-cookie'] || [];
      const tokenHeader = setCookieRaw.find((h: string) => h.startsWith('token='));
      expect(tokenHeader).toMatch(/HttpOnly/i);
      expect(tokenHeader).toMatch(/SameSite=Lax/i);
    });
  });

  // ===================================================================================================================
  // BetterAuth IAM — REST sign-up/sign-in (cookie-only mode)
  // ===================================================================================================================

  describe('BetterAuth IAM REST — cookie-only mode', () => {
    it('POST /iam/sign-up/email MUST set session_token cookie AND strip token from body', async () => {
      const email = makeEmail('iam-signup');

      const response = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'IAM Test User', password: 'SecurePass123!', termsAndPrivacyAccepted: true },
        returnResponse: true,
        statusCode: 201,
      });

      // Body: no token (cookie-only mode, default exposeTokenInBody=false)
      expect(response.body.token).toBeFalsy();
      expect(response.body.user?.email).toBe(email);

      // Cookie: iam.session_token MUST be set
      const cookies = TestHelper.extractCookies(response);
      expect(cookies['iam.session_token']).toBeDefined();
      expect(cookies['iam.session_token'].length).toBeGreaterThan(0);

      // httpOnly flag on session cookie
      const setCookieRaw = response.headers['set-cookie'] || [];
      const sessionHeader = setCookieRaw.find((h: string) => h.startsWith('iam.session_token='));
      expect(sessionHeader).toMatch(/HttpOnly/i);
      expect(sessionHeader).toMatch(/SameSite=Lax/i);
    });

    it('POST /iam/sign-in/email MUST set session_token cookie AND strip token from body', async () => {
      const email = makeEmail('iam-signin');

      // Prerequisite: sign up the user
      await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'IAM Sign-In Test', password: 'SecurePass123!', termsAndPrivacyAccepted: true },
        statusCode: 201,
      });

      const response = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password: 'SecurePass123!' },
        returnResponse: true,
        statusCode: 200,
      });

      // Body: no token
      expect(response.body.token).toBeFalsy();

      // Cookie: iam.session_token MUST be set
      const cookies = TestHelper.extractCookies(response);
      expect(cookies['iam.session_token']).toBeDefined();
      expect(cookies['iam.session_token'].length).toBeGreaterThan(0);
    });
  });

  // ===================================================================================================================
  // BetterAuth IAM — REST hybrid mode (exposeTokenInBody: true)
  // Toggles config for this describe block only; restores afterwards.
  // ===================================================================================================================

  describe('BetterAuth IAM REST — hybrid mode (exposeTokenInBody)', () => {
    let hybridSnapshot: unknown;

    beforeAll(() => {
      hybridSnapshot = ConfigService.configFastButReadOnly?.cookies;
      ConfigService.setProperty('cookies', { exposeTokenInBody: true });
    });

    afterAll(() => {
      // Restore back to the outer describe's `true` setting (not the original e2e config;
      // the outer afterAll handles final restore to the e2e default).
      ConfigService.setProperty('cookies', hybridSnapshot);
    });

    it('POST /iam/sign-in/email MUST return JWT in body AND set session_token cookie', async () => {
      const email = makeEmail('iam-hybrid');

      await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'IAM Hybrid Test', password: 'SecurePass123!', termsAndPrivacyAccepted: true },
        statusCode: 201,
      });

      const response = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password: 'SecurePass123!' },
        returnResponse: true,
        statusCode: 200,
      });

      // Body: token MUST be present AND be a JWT (3 base64url segments)
      expect(response.body.token).toBeDefined();
      expect(typeof response.body.token).toBe('string');
      expect(response.body.token.split('.').length).toBe(3);
      expect(response.body.token.startsWith('eyJ')).toBe(true);

      // Cookie: iam.session_token MUST ALSO be set in parallel
      const cookies = TestHelper.extractCookies(response);
      expect(cookies['iam.session_token']).toBeDefined();
      expect(cookies['iam.session_token'].length).toBeGreaterThan(0);
    });
  });
});
