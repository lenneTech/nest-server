/**
 * Login CSRF on the IAM sign-in and sign-up.
 *
 * Better-Auth protects both endpoints itself (`formCsrfMiddleware`): a cross-site NAVIGATION is
 * refused, and a present `Origin` must be trusted. It reads both from `ctx.request` — and the
 * controller called `api.signInEmail()` / `api.signUpEmail()` without one, so the check never ran. A
 * hostile page could submit a form to `/iam/sign-in/email` with the attacker's credentials and the
 * visitor's browser kept the session: whatever the visitor did next happened in the attacker's
 * account, approving an MCP client on the consent page included.
 *
 * Each refusal is paired with the clients that must keep working: the trusted origins (API and app),
 * and a non-browser client that sends none of these headers.
 */
import { NestExpressApplication } from '@nestjs/platform-express';
import { Db, MongoClient } from 'mongodb';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthModule, CoreBetterAuthService, TestHelper } from '../src';
import { ConfigService } from '../src/core/common/services/config.service';
import { apiTokenIamConfig, bootApiTokenIamApp } from './helpers/api-token-e2e.helpers';
import { captureExpectedLogs } from './helpers/expected-log-output';

const CROSS_SITE_FORM = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site' };

describe('IAM sign-in / sign-up — Better-Auth CSRF protection runs (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let mongo: MongoClient;
  let previousConfig: any;
  let trusted: string[];
  const email = `signin-csrf-${Date.now()}@test.com`;
  const password = 'SignInCsrfPassword123!';

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly;
    const base = apiTokenIamConfig('signin-csrf', {});
    // Better-Auth skips its origin/CSRF checks under a test runner by default (`isTest()`); a
    // deployment runs them. Switched on here so this spec sees what production does.
    const config = {
      ...base,
      betterAuth: {
        ...base.betterAuth,
        options: {
          ...base.betterAuth?.options,
          advanced: { ...base.betterAuth?.options?.advanced, disableOriginCheck: false },
        },
      },
    };
    app = await bootApiTokenIamApp(config);
    // The origins the running instance trusts — derived from baseUrl / appUrl, not spelled out in config.
    const context: any = await (app.get(CoreBetterAuthService).getInstance() as any).$context;
    trusted = context.trustedOrigins.filter((origin: string) => /^https?:\/\/[^*]+$/.test(origin));
    expect(trusted.length).toBeGreaterThan(0);
    mongo = await MongoClient.connect(config.mongoose.uri);
    db = mongo.db();
    await new TestHelper(app).rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: 'CSRF', password, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });
    await db.collection('users').updateOne({ email }, { $set: { emailVerified: true, verified: true } });
    await db.collection('iam_user').updateOne({ email }, { $set: { emailVerified: true } });
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.close();
    CoreBetterAuthModule.reset();
    if (previousConfig) {
      ConfigService.setConfig(previousConfig, { reInit: true, warn: false });
    }
  });

  const signIn = (headers: Record<string, string>, form = false) => {
    const call = request(app.getHttpServer()).post('/iam/sign-in/email').set(headers);
    return form ? call.type('form').send({ email, password }) : call.send({ email, password });
  };
  const sessionCookie = (response: request.Response) =>
    ([] as string[]).concat(response.headers['set-cookie'] ?? []).find((cookie) => cookie.includes('session_token'));

  /**
   * @regression   11.42.16 and earlier — the controller called api.signInEmail() without a request, so
   *   Better-Auth's formCsrfMiddleware never ran: a cross-site form signed the visitor in (login CSRF).
   * @seen-failing Registered as `iam-signin-csrf-check-skipped` in tests/regression-mutations.json.
   */
  it('refuses a sign-in a hostile page submits as a form, and sets no session cookie', async () => {
    // Better-Auth reports every refused attempt as an error (through Nest's logger since 12.0.0).
    const refusals = captureExpectedLogs();
    const response = await signIn({ ...CROSS_SITE_FORM, origin: 'https://evil.example' }, true);

    expect(response.status).toBe(403);
    expect(sessionCookie(response)).toBeUndefined();
    expect(refusals.join('\n')).toMatch(/Blocked cross-site navigation login attempt|Invalid origin/);
  });

  /**
   * @regression   Same defect, the scripted variant: a cross-origin fetch from an untrusted origin.
   * @seen-failing Registered as `iam-signin-csrf-check-skipped` in tests/regression-mutations.json.
   */
  it('refuses a sign-in from an untrusted origin', async () => {
    const refusals = captureExpectedLogs();
    const response = await signIn({
      origin: 'https://evil.example',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'cross-site',
    });

    expect(response.status).toBe(403);
    expect(sessionCookie(response)).toBeUndefined();
    expect(refusals.join('\n')).toContain('Invalid origin: https://evil.example');
  });

  it('signs in from a trusted origin, from the API origin itself and from a client without browser headers', async () => {
    for (const origin of trusted) {
      const fromTrusted = await signIn({ origin, 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' });
      expect(fromTrusted.status, origin).toBe(200);
      expect(sessionCookie(fromTrusted), origin).toBeDefined();
    }

    const nonBrowser = await signIn({});
    expect(nonBrowser.status).toBe(200);
  });

  /**
   * @regression   Found while walking the consent page for 11.43.0, before release: the controller
   *   forwarded fetch metadata unconditionally, and Node's built-in fetch (undici) sends a lone
   *   `Sec-Fetch-Mode: cors` without an Origin — Better-Auth reads that as a browser request missing its
   *   origin, so every script, seeder or SSR route signing in with fetch answered 403.
   * @seen-failing Registered as `iam-signin-csrf-nonbrowser-metadata-forwarded` in
   *   tests/regression-mutations.json.
   */
  it('signs in a server-side Node fetch client, which sends Sec-Fetch-Mode without an Origin', async () => {
    // The header shape undici sends, pinned on its own so a change in Node's fetch cannot hollow this out.
    const undiciShape = await signIn({ 'sec-fetch-mode': 'cors' });
    expect(undiciShape.status).toBe(200);
    expect(sessionCookie(undiciShape)).toBeDefined();

    // And the real client.
    const server = app.getHttpServer();
    if (!server.listening) {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    }
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/iam/sign-in/email`, {
      body: JSON.stringify({ email, password }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(200);
  });

  /**
   * @regression   The paired refusal: a browser always sends `Sec-Fetch-Site` with its fetch metadata, so
   *   a cross-site navigation stays refused even where no Origin arrives — reading only Origin / Referer
   *   as the browser signal would wave it through.
   * @seen-failing Registered as `iam-signin-csrf-site-not-a-browser-signal` in
   *   tests/regression-mutations.json.
   */
  it('still refuses a cross-site navigation that carries no Origin', async () => {
    const refusals = captureExpectedLogs();
    const response = await signIn(CROSS_SITE_FORM, true);

    expect(response.status).toBe(403);
    expect(sessionCookie(response)).toBeUndefined();
    expect(refusals.join('\n')).toContain('Blocked cross-site navigation login attempt');
  });

  /**
   * @regression   11.42.16 and earlier — sign-up had the same gap: a hostile page could create an
   *   account and sign the visitor in to it.
   * @seen-failing Registered as `iam-signup-csrf-check-skipped` in tests/regression-mutations.json.
   */
  it('refuses a cross-site sign-up, and creates no account', async () => {
    const victimEmail = `signup-csrf-${Date.now()}@test.com`;
    const refusals = captureExpectedLogs();

    // JSON with the browser's cross-site signals: a urlencoded form already fails the input
    // validation (no boolean for termsAndPrivacyAccepted), which would hide whether this check runs.
    const response = await request(app.getHttpServer())
      .post('/iam/sign-up/email')
      .set({ ...CROSS_SITE_FORM, origin: 'https://evil.example' })
      .send({ email: victimEmail, name: 'Victim', password, termsAndPrivacyAccepted: true });

    expect(response.status).toBe(403);
    expect(await db.collection('users').countDocuments({ email: victimEmail })).toBe(0);
    expect(refusals.join('\n')).toContain('Blocked cross-site navigation login attempt');
  });
});
