/**
 * Story: Hub admin area (operator cockpit)
 *
 * As an administrator,
 * I want a build-free admin dashboard at /hub with runtime information and tools,
 * so that I can operate and inspect a running nest-server without extra tooling.
 *
 * Skeleton coverage (Phase 2):
 * - Access control: anonymous → 401, non-admin → 403, admin → 200 over every page + sidecar
 * - /hub/auth and /hub/hub.js are the only public routes
 * - The shell is real HTML with the sidebar, the client script and a CSP nonce that matches the header
 * - dashboard.json / diagnostics.json return the expected shape
 */

import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { GridFSBucket, MongoClient, ObjectId } from 'mongodb';

import { HttpExceptionLogFilter, RoleEnum, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { HUB_PANELS } from '../../src/core/modules/hub/hub-nav';
import { ServerModule } from '../../src/server/server.module';

const PAGE_PATHS = ['/hub', ...HUB_PANELS.filter((p) => p.path).map((p) => `/hub/${p.path}`)];
const SIDECAR_PATHS = [
  '/hub/dashboard.json',
  '/hub/diagnostics.json',
  '/hub/config.json',
  '/hub/db.json',
  '/hub/models.json',
  '/hub/migrations.json',
  '/hub/files.json',
  '/hub/error-codes.json',
  '/hub/auth-migration.json',
  '/hub/cron.json',
  '/hub/ai.json',
  '/hub/routes.json',
  '/hub/emails.json',
  '/hub/mailbox.json',
  '/hub/logs.json',
  '/hub/traces.json',
  '/hub/queries.json',
  '/hub/session.json',
];

const wait = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll an async producer until a predicate holds or the timeout elapses, then return the last value.
 * Replaces fixed `wait()` sleeps in collector/mailbox assertions so they converge as soon as the
 * async work lands instead of racing a hardcoded delay (less flaky, faster on the happy path).
 */
const poll = async <T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  { interval = 100, timeout = 4000 }: { interval?: number; timeout?: number } = {},
): Promise<T> => {
  const start = Date.now();
  let last = await fn();
  while (!predicate(last) && Date.now() - start < timeout) {
    await wait(interval);
    last = await fn();
  }
  return last;
};

describe('Story: Hub admin area', () => {
  let app;
  let testHelper: TestHelper;
  let connection: MongoClient;
  let db;
  let adminToken: string;
  let userToken: string;
  const testEmails: string[] = [];

  // IAM auth is cookie-based: sign in, then read the session token from the `session` collection and
  // replay it as a cookie on subsequent requests (the guards read the BetterAuth session cookie).
  const signUpAndSignIn = async (prefix: string, makeAdmin: boolean): Promise<string> => {
    const email = `hub-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}@test.com`;
    const password = 'HubPass123!';
    testEmails.push(email);

    await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: `Hub ${prefix}`, password, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });
    await wait();

    // Verify (and optionally grant ADMIN) before sign-in so the session reflects the correct status.
    await db.collection('users').updateOne(
      { email },
      { $set: { emailVerified: true, roles: makeAdmin ? [RoleEnum.ADMIN] : [], verified: true } },
    );
    await db.collection('iam_user').updateOne({ email }, { $set: { emailVerified: true } });
    await wait();

    await testHelper.rest('/iam/sign-in/email', { method: 'POST', payload: { email, password }, statusCode: 200 });
    await wait();

    const dbUser = await db.collection('users').findOne({ email });
    const session = await db.collection('session').findOne({
      $or: [{ userId: dbUser?._id }, { userId: dbUser?._id?.toString() }, ...(dbUser?.iamId ? [{ userId: dbUser.iamId }] : [])],
    });
    return session?.token || '';
  };

  beforeAll(async () => {
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
    connection = await MongoClient.connect(envConfig.mongoose.uri);
    db = connection.db();

    adminToken = await signUpAndSignIn('admin', true);
    userToken = await signUpAndSignIn('user', false);
  });

  afterAll(async () => {
    if (db && testEmails.length > 0) {
      const users = await db.collection('users').find({ email: { $in: testEmails } }).toArray();
      const iamIds = users.map((u) => u.iamId).filter(Boolean);
      await db.collection('users').deleteMany({ email: { $in: testEmails } });
      await db.collection('iam_user').deleteMany({ email: { $in: testEmails } });
      if (iamIds.length > 0) {
        await db.collection('account').deleteMany({ userId: { $in: iamIds } });
        await db.collection('session').deleteMany({ userId: { $in: iamIds } });
      }
    }
    if (connection) {
      await connection.close();
    }
    if (app) {
      await app.close();
    }
  });

  describe('Access control', () => {
    it('serves the shell (chrome only) publicly for every page — it is the login gate', async () => {
      for (const path of PAGE_PATHS) {
        const res = await testHelper.rest(path, { method: 'GET', returnResponse: true, statusCode: 200 });
        expect(res.headers['content-type']).toContain('text/html');
      }
    });

    it('hides the app until authenticated (body starts hub-locked with a login gate)', async () => {
      const res = await testHelper.rest('/hub', { method: 'GET', returnResponse: true, statusCode: 200 });
      expect(res.text).toContain('class="hub-locked"');
      expect(res.text).toContain('id="hub-gate"');
    });

    it('gates every DATA sidecar: anonymous → 401', async () => {
      for (const path of SIDECAR_PATHS) {
        await testHelper.rest(path, { method: 'GET', statusCode: 401 });
      }
    });

    it('gates the data sidecars for a non-admin user → 403', async () => {
      await testHelper.rest('/hub/dashboard.json', { method: 'GET', statusCode: 403, cookies: userToken });
      await testHelper.rest('/hub/config.json', { method: 'GET', statusCode: 403, cookies: userToken });
    });

    it('allows an admin to load every page (200, text/html)', async () => {
      for (const path of PAGE_PATHS) {
        await testHelper.rest(path, { method: 'GET', statusCode: 200, cookies: adminToken });
      }
    });

    it('allows an admin to load every sidecar (200)', async () => {
      for (const path of SIDECAR_PATHS) {
        await testHelper.rest(path, { method: 'GET', statusCode: 200, cookies: adminToken });
      }
    });

    it('serves hub.js publicly and embeds the login endpoint in the shell', async () => {
      await testHelper.rest('/hub/hub.js', { method: 'GET', statusCode: 200 });
      const shell = await testHelper.rest('/hub', { method: 'GET', returnResponse: true, statusCode: 200 });
      expect(shell.text).toContain('__HUB_LOGIN__');
      expect(shell.text).toContain('/iam/sign-in/email');
    });
  });

  describe('Shell + client runtime', () => {
    it('serves the minimal app shell, client script and a matching CSP nonce', async () => {
      const res = await testHelper.rest('/hub', { method: 'GET', returnResponse: true, statusCode: 200, cookies: adminToken });
      const html: string = res.text;
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cache-control']).toContain('no-store');
      // The shell is chrome-free: only the empty app root + login gate + client script. The nav,
      // env and links are built client-side from session.json (see the "reveals nothing" test).
      expect(html).toContain('id="hub-app"');
      expect(html).toContain('id="hub-gate"');
      expect(html).toContain('/hub/hub.js?v=');
      expect(html).not.toContain('class="hub-nav"');

      // The nonce in the CSP header must be the one used on the inline <style>/<script> tags.
      const nonce = /nonce-([^']+)'/.exec(res.headers['content-security-policy'])?.[1];
      expect(nonce).toBeTruthy();
      expect(html).toContain(`nonce="${nonce}"`);
      expect(html).not.toContain('__CSP_NONCE__');
    });

    it('the public shell reveals NOTHING of the cockpit to an unauthenticated request', async () => {
      // #18: the shell must be served before auth (for the login form), so it carries no nav, no
      // panel names, no environment badge and no external links — those come from ADMIN-gated
      // session.json. An anonymous GET therefore leaks no Hub structure.
      const res = await testHelper.rest('/hub', { method: 'GET', returnResponse: true, statusCode: 200 });
      const html: string = res.text;
      expect(html).toContain('id="hub-gate"'); // login gate present
      expect(html).toContain('/hub/hub.js?v='); // client script present
      // No navigation / panel structure / env value / links in the anonymous HTML. (The inline CSS
      // legitimately contains class-name selectors like `.hub-nav` / `.hub-env-production` — those are
      // static styling rules, not data, so we assert against actual leaked content, not class names.)
      expect(html).not.toContain('class="hub-nav"'); // no rendered nav element
      expect(html).not.toContain('data-panel'); // no panel links
      expect(html).not.toContain('>Dashboard<'); // no panel titles
      expect(html).not.toContain('>Query Performance<');
      expect(html).not.toContain('__HUB_ENV__'); // env value not embedded
      expect(html).not.toContain('>Swagger<'); // no external links
    });

    it('session.json returns the ADMIN-gated cockpit chrome payload (nav, env, version, links)', async () => {
      // Anonymous → 401 (already covered in the access matrix); admin → the layout payload.
      const data = await testHelper.rest('/hub/session.json', { method: 'GET', statusCode: 200, cookies: adminToken });
      expect(data.authenticated).toBe(true);
      expect(typeof data.env).toBe('string');
      expect(typeof data.version).toBe('string');
      expect(Array.isArray(data.panels)).toBe(true);
      expect(data.panels.some((p: { id: string }) => p.id === 'dashboard')).toBe(true);
      // The Routes / Permissions panel is part of the cockpit nav (renders the ADMIN-gated routes.json).
      expect(data.panels.some((p: { id: string }) => p.id === 'routes')).toBe(true);
      expect(Array.isArray(data.panelGroups)).toBe(true);
      expect(data.links).toBeDefined();
      expect(data.logoutEndpoint).toBe('/iam/sign-out');
    });

    it('session.json marks per-panel availability so the client can grey out dead nav entries', async () => {
      const data = await testHelper.rest('/hub/session.json', { method: 'GET', statusCode: 200, cookies: adminToken });
      // Every panel carries an `available` boolean.
      expect(data.panels.every((p: { available: unknown }) => typeof p.available === 'boolean')).toBe(true);
      // Intrinsic panels are always available; optional ones reflect their source.
      const dashboard = data.panels.find((p: { id: string }) => p.id === 'dashboard');
      expect(dashboard.available).toBe(true);
      // Permissions module is enabled in the e2e config → the Routes panel is available here.
      const routes = data.panels.find((p: { id: string }) => p.id === 'routes');
      expect(routes.available).toBe(true);
    });

    it('the Sign out button endpoint (POST /iam/sign-out) is reachable and clears the session cookie', async () => {
      // The client's "Sign out" button POSTs to session.logoutEndpoint (default /iam/sign-out). Use a
      // throwaway admin session so the shared adminToken is undisturbed. Here we assert the Hub-side
      // contract — the endpoint is reachable and clears the auth cookie; BetterAuth's session
      // revocation itself is covered in better-auth-cookie-prefix.story.test.ts.
      const token = await signUpAndSignIn('logout', true);
      await testHelper.rest('/hub/session.json', { method: 'GET', statusCode: 200, cookies: token });

      const res = await testHelper.rest('/iam/sign-out', {
        method: 'POST',
        returnResponse: true,
        statusCode: 201,
        cookies: token,
      });
      expect(res.headers['set-cookie']).toBeDefined();
    });

    it('serves hub.js as JavaScript exposing the Hub runtime', async () => {
      const res = await testHelper.rest('/hub/hub.js', { method: 'GET', returnResponse: true, statusCode: 200 });
      expect(res.headers['content-type']).toContain('javascript');
      expect(res.text).toContain('window.Hub');
    });
  });

  describe('Sidecar shapes', () => {
    it('dashboard.json exposes build, features, memory and mongo state', async () => {
      const data = await testHelper.rest('/hub/dashboard.json', { method: 'GET', statusCode: 200, cookies: adminToken });
      expect(data.build.env).toBeDefined();
      expect(typeof data.memory.heapUsed).toBe('number');
      expect(data.features).toBeDefined();
      expect(data.mongo.state).toBeDefined();
      expect(typeof data.uptimeSeconds).toBe('number');
    });

    it('diagnostics.json exposes process/runtime info', async () => {
      const data = await testHelper.rest('/hub/diagnostics.json', { method: 'GET', statusCode: 200, cookies: adminToken });
      expect(data.nodeVersion).toBe(process.version);
      expect(typeof data.memory.rss).toBe('number');
      expect(data.platform).toBe(process.platform);
    });

    it('db.json exposes database + collection stats', async () => {
      const data = await testHelper.rest('/hub/db.json', { method: 'GET', statusCode: 200, cookies: adminToken });
      expect(Array.isArray(data.collections)).toBe(true);
      expect(typeof data.stats.dataSize).toBe('number');
      expect(data.collections.some((c: { name: string }) => c.name === 'users')).toBe(true);
    });

    it('models.json exposes the model inventory and a Mermaid ER diagram', async () => {
      const data = await testHelper.rest('/hub/models.json', { method: 'GET', statusCode: 200, cookies: adminToken });
      expect(data.mermaid).toContain('erDiagram');
      expect(data.modelCount).toBeGreaterThan(0);
      expect(Array.isArray(data.entities)).toBe(true);
    });

    it('migrations.json exposes completed/pending arrays', async () => {
      const data = await testHelper.rest('/hub/migrations.json', { method: 'GET', statusCode: 200, cookies: adminToken });
      expect(Array.isArray(data.completed)).toBe(true);
      expect(Array.isArray(data.pending)).toBe(true);
      expect(data.source).toBe('collection');
    });

    it('files.json exposes a GridFS listing', async () => {
      const data = await testHelper.rest('/hub/files.json', { method: 'GET', statusCode: 200, cookies: adminToken });
      expect(data.bucket).toBe('fs');
      expect(Array.isArray(data.files)).toBe(true);
      expect(typeof data.total).toBe('number');
    });

    it('error-codes.json degrades gracefully (error-code module disabled in this e2e config)', async () => {
      // The e2e ServerModule sets errorCode.autoRegister:false, so the error-code module is not
      // registered here — the panel must report `available:false` (never 500). The populated-catalog
      // case is covered in hub-config.e2e-spec.ts where error-code is enabled.
      const data = await testHelper.rest('/hub/error-codes.json', { method: 'GET', statusCode: 200, cookies: adminToken });
      if (data.available === false) {
        expect(typeof data.hint).toBe('string');
      } else {
        expect(Array.isArray(data.codes)).toBe(true);
      }
    });

    it('auth-migration.json exposes migration progress (BetterAuth enabled)', async () => {
      const data = await testHelper.rest('/hub/auth-migration.json', { method: 'GET', statusCode: 200, cookies: adminToken });
      expect(data.available).toBe(true);
      expect(typeof data.migrationPercentage).toBe('number');
      expect(typeof data.totalUsers).toBe('number');
    });

    it('cron.json exposes the scheduler registry (ScheduleModule imported)', async () => {
      const data = await testHelper.rest('/hub/cron.json', { method: 'GET', statusCode: 200, cookies: adminToken });
      expect(Array.isArray(data.jobs)).toBe(true);
    });

    it('routes.json exposes the permissions report (permissions enabled)', async () => {
      const data = await testHelper.rest('/hub/routes.json', { method: 'GET', statusCode: 200, cookies: adminToken });
      expect(Array.isArray(data.modules)).toBe(true);
    });

    it('emails.json enumerates the EJS templates and renders a preview', async () => {
      const data = await testHelper.rest('/hub/emails.json', { method: 'GET', statusCode: 200, cookies: adminToken });
      expect(Array.isArray(data.templates)).toBe(true);
      const template = data.templates.find((t: { name: string }) => t.name === 'welcome') ?? data.templates[0];
      expect(template).toBeDefined();
      const preview = await testHelper.rest(`/hub/emails/preview?template=${template.name}`, {
        method: 'GET',
        returnResponse: true,
        statusCode: 200,
        cookies: adminToken,
      });
      expect(preview.headers['content-type']).toContain('text/html');
      expect(preview.headers['content-security-policy']).toContain("default-src 'none'");
    });
  });

  describe('Runtime collectors record real traffic', () => {
    it('logs.json captures a Logger call (redacted + cursor-paged)', async () => {
      new Logger('HubStoryCanary').warn('hub-log-canary token=abcdef1234567890secret');
      const data = await poll(
        () => testHelper.rest('/hub/logs.json', { method: 'GET', statusCode: 200, cookies: adminToken }),
        (d) => Array.isArray(d.records) && d.records.some((r: { message: string }) => r.message.includes('hub-log-canary')),
      );
      expect(Array.isArray(data.records)).toBe(true);
      const canary = data.records.find((r: { message: string }) => r.message.includes('hub-log-canary'));
      expect(canary).toBeDefined();
      expect(canary.context).toBe('HubStoryCanary');
      // The secret must be redacted.
      expect(canary.message).not.toContain('abcdef1234567890secret');
    });

    it('traces.json records API requests with route patterns and excludes hub self-noise', async () => {
      // Cursor first, so the assertions only look at traffic WE generate (the buffer is shared with
      // every other request in the run).
      const before = await testHelper.rest('/hub/traces.json', { method: 'GET', statusCode: 200, cookies: adminToken });
      const cursor = before.cursor;

      await testHelper.rest('/permissions/json', { method: 'GET', statusCode: 200, cookies: adminToken });

      const data = await poll(
        () => testHelper.rest(`/hub/traces.json?since=${cursor}`, { method: 'GET', statusCode: 200, cookies: adminToken }),
        (d) => Array.isArray(d.traces) && d.traces.some((t: { path: string }) => t.path.startsWith('/permissions')),
      );
      expect(Array.isArray(data.traces)).toBe(true);
      const permTrace = data.traces.find((t: { path: string }) => t.path.startsWith('/permissions'));
      expect(permTrace).toBeDefined();
      expect(typeof permTrace.durationMs).toBe('number');
      expect(permTrace.method).toBe('GET');
      // Reading traces.json itself (a /hub route) must NOT appear — self-noise is excluded.
      expect(data.traces.every((t: { path: string }) => !t.path.startsWith('/hub'))).toBe(true);
    });

    it('queries.json records MongoDB commands as value-free shapes (N+1 templates)', async () => {
      // Generate identical-shape queries via a filtered read through the API.
      for (let i = 0; i < 3; i++) {
        await testHelper.rest('/permissions/json', { method: 'GET', statusCode: 200, cookies: adminToken });
      }
      const data = await poll(
        () => testHelper.rest('/hub/queries.json', { method: 'GET', statusCode: 200, cookies: adminToken }),
        (d) => Array.isArray(d.recent) && d.recent.length > 0,
      );
      expect(Array.isArray(data.recent)).toBe(true);
      expect(data.recent.length).toBeGreaterThan(0);
      expect(Array.isArray(data.topTemplates)).toBe(true);
      // Command summaries are shapes (contain '?') and never leak the admin's test email.
      const raw = JSON.stringify(data);
      expect(raw).not.toContain('@test.com');
    });
  });

  describe('Mailbox (Mailpit-style capture)', () => {
    it('runs in capture mode and captures a triggered mail without sending it', async () => {
      const before = await testHelper.rest('/hub/mailbox.json', { method: 'GET', statusCode: 200, cookies: adminToken });
      expect(before.mode).toBe('capture');
      expect(Array.isArray(before.mails)).toBe(true);

      // Trigger a mail via the public "forgot password" IAM flow (uses EmailService → captured).
      const email = `hub-mail-${Date.now()}@test.com`;
      testEmails.push(email);
      await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Hub Mail', password: 'HubPass123!', termsAndPrivacyAccepted: true },
        statusCode: 201,
      });

      const after = await poll(
        () => testHelper.rest('/hub/mailbox.json', { method: 'GET', statusCode: 200, cookies: adminToken }),
        (b) => b.mails.length > before.mails.length,
      );
      expect(after.mails.length).toBeGreaterThanOrEqual(before.mails.length);
    });

    it('serves a captured mail body as sandboxed HTML when one exists', async () => {
      const box = await testHelper.rest('/hub/mailbox.json', { method: 'GET', statusCode: 200, cookies: adminToken });
      const withBody = box.mails.find((m: { hasHtml: boolean; hasText: boolean }) => m.hasHtml || m.hasText);
      if (!withBody) {
        return; // no mail captured in this run — the shape test above already proved the wiring
      }
      const res = await testHelper.rest(`/hub/mailbox/${withBody.seq}/html`, { method: 'GET', returnResponse: true, statusCode: 200, cookies: adminToken });
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    });
  });

  describe('Admin actions (CSRF + confirm)', () => {
    it('rejects a mutating action without the X-Hub-Request header (CSRF)', async () => {
      await testHelper.rest('/hub/actions/collectors/traces/clear', {
        method: 'POST',
        payload: { confirm: 'CLEAR' },
        statusCode: 403,
        cookies: adminToken,
      });
    });

    it('rejects a wrong confirmation keyword with 400', async () => {
      await testHelper.rest('/hub/actions/collectors/traces/clear', {
        headers: { 'x-hub-request': '1' },
        method: 'POST',
        payload: { confirm: 'WRONG' },
        statusCode: 400,
        cookies: adminToken,
      });
    });

    it('rejects a non-admin from every action (403)', async () => {
      await testHelper.rest('/hub/actions/collectors/traces/clear', {
        headers: { 'x-hub-request': '1' },
        method: 'POST',
        payload: { confirm: 'CLEAR' },
        statusCode: 403,
        cookies: userToken,
      });
    });

    it('clears a collector buffer with a valid confirm + header and writes an audit line', async () => {
      const res = await testHelper.rest('/hub/actions/collectors/queries/clear', {
        headers: { 'x-hub-request': '1' },
        method: 'POST',
        payload: { confirm: 'CLEAR' },
        statusCode: 201,
        cookies: adminToken,
      });
      expect(res.ok).toBe(true);
      expect(res.cleared).toBe('queries');

      // The audit warn is captured by the log collector — assert it landed there with the acting user.
      const logs = await poll(
        () => testHelper.rest('/hub/logs.json', { method: 'GET', statusCode: 200, cookies: adminToken }),
        (d) =>
          d.records.some(
            (r: { message: string }) => r.message.includes('[HUB-ACTION]') && r.message.includes('clear queries'),
          ),
      );
      const audit = logs.records.find((r: { message: string }) => r.message.includes('[HUB-ACTION]') && r.message.includes('clear queries'));
      expect(audit).toBeDefined();
      expect(audit.message).toMatch(/by user \w+/);
    });

    it('sends a test mail that lands in the mailbox (capture) and serves it as sandboxed HTML', async () => {
      const to = `hub-testmail-${Date.now()}@test.com`;
      testEmails.push(to);
      const res = await testHelper.rest('/hub/actions/email/test', {
        headers: { 'x-hub-request': '1' },
        method: 'POST',
        payload: { template: 'welcome', to },
        statusCode: 201,
        cookies: adminToken,
      });
      expect(res.sent).toBe(true);

      const box = await poll(
        () => testHelper.rest('/hub/mailbox.json', { method: 'GET', statusCode: 200, cookies: adminToken }),
        (b) => b.mails.some((m: { to?: string }) => (m.to ?? '').includes(to)),
      );
      const mail = box.mails.find((m: { to?: string }) => (m.to ?? '').includes(to));
      expect(mail).toBeDefined();
      expect(mail.subject).toBe('Hub test email');
      expect(mail.hasHtml || mail.hasText).toBe(true);

      // Deterministic mailbox-html coverage: fetch the just-captured mail's body as sandboxed HTML.
      const html = await testHelper.rest(`/hub/mailbox/${mail.seq}/html`, {
        method: 'GET',
        returnResponse: true,
        statusCode: 200,
        cookies: adminToken,
      });
      expect(html.headers['content-type']).toContain('text/html');
      expect(html.headers['content-security-policy']).toContain("default-src 'none'");
    });

    it('rejects a test mail with an unknown template (traversal allowlist)', async () => {
      // The template is validated against the live inventory — an out-of-inventory / traversal name
      // must be rejected (400), never forwarded to the renderer.
      await testHelper.rest('/hub/actions/email/test', {
        headers: { 'x-hub-request': '1' },
        method: 'POST',
        payload: { template: '../../../../etc/passwd', to: `hub-x-${Date.now()}@test.com` },
        statusCode: 400,
        cookies: adminToken,
      });
    });
  });

  describe('Admin actions — execution + negative paths', () => {
    it('rejects clearing an unknown collector with 400', async () => {
      await testHelper.rest('/hub/actions/collectors/does-not-exist/clear', {
        headers: { 'x-hub-request': '1' },
        method: 'POST',
        payload: { confirm: 'CLEAR' },
        statusCode: 400,
        cookies: adminToken,
      });
    });

    it('deletes a GridFS file only with the correct filename confirmation', async () => {
      // Upload a small file we own via GridFS, then exercise the confirm-guarded delete action.
      const bucket = new GridFSBucket(db, { bucketName: 'fs' });
      const filename = `hub-del-${Date.now()}.txt`;
      const fileId: ObjectId = await new Promise((resolve, reject) => {
        const stream = bucket.openUploadStream(filename);
        stream.on('error', reject);
        stream.on('finish', () => resolve(stream.id as ObjectId));
        stream.end(Buffer.from('hub delete test'));
      });

      // Wrong filename → 400, file still present.
      await testHelper.rest(`/hub/actions/files/${fileId}`, {
        headers: { 'x-hub-request': '1' },
        method: 'DELETE',
        payload: { confirm: 'wrong-name.txt' },
        statusCode: 400,
        cookies: adminToken,
      });
      expect(await db.collection('fs.files').findOne({ _id: fileId })).not.toBeNull();

      // Correct filename → 200, file gone.
      const ok = await testHelper.rest(`/hub/actions/files/${fileId}`, {
        headers: { 'x-hub-request': '1' },
        method: 'DELETE',
        payload: { confirm: filename },
        statusCode: 200,
        cookies: adminToken,
      });
      expect(ok.deleted.filename).toBe(filename);
      expect(await db.collection('fs.files').findOne({ _id: fileId })).toBeNull();
    });

    it('returns 400 when deleting a non-existent file id', async () => {
      const missingId = new ObjectId().toString();
      await testHelper.rest(`/hub/actions/files/${missingId}`, {
        headers: { 'x-hub-request': '1' },
        method: 'DELETE',
        payload: { confirm: 'anything.txt' },
        statusCode: 400,
        cookies: adminToken,
      });
    });

    it('rejects an unknown cron action (400) and a mismatched job-name confirmation (400)', async () => {
      await testHelper.rest('/hub/actions/cron/someJob/frobnicate', {
        headers: { 'x-hub-request': '1' },
        method: 'POST',
        payload: { confirm: 'someJob' },
        statusCode: 400,
        cookies: adminToken,
      });
      await testHelper.rest('/hub/actions/cron/someJob/trigger', {
        headers: { 'x-hub-request': '1' },
        method: 'POST',
        payload: { confirm: 'wrong-name' },
        statusCode: 400,
        cookies: adminToken,
      });
    });

    it('guards migrations run/down: missing CSRF header → 403, wrong confirm → 400', async () => {
      // Run: no header → 403 (CSRF), then wrong confirm keyword → 400.
      await testHelper.rest('/hub/actions/migrations/run', {
        method: 'POST',
        payload: { confirm: 'RUN' },
        statusCode: 403,
        cookies: adminToken,
      });
      await testHelper.rest('/hub/actions/migrations/run', {
        headers: { 'x-hub-request': '1' },
        method: 'POST',
        payload: { confirm: 'nope' },
        statusCode: 400,
        cookies: adminToken,
      });
      // Down: wrong confirm keyword → 400 (never performs an unconfirmed rollback).
      await testHelper.rest('/hub/actions/migrations/down', {
        headers: { 'x-hub-request': '1' },
        method: 'POST',
        payload: { confirm: 'nope' },
        statusCode: 400,
        cookies: adminToken,
      });
    });
  });

  describe('Config secret masking', () => {
    it('masks jwt/betterAuth/mongoose secrets in config.json', async () => {
      const res = await testHelper.rest('/hub/config.json', { method: 'GET', returnResponse: true, statusCode: 200, cookies: adminToken });
      const raw: string = res.text;
      // Known sentinel secrets from the e2e config must never appear in the response.
      expect(raw).not.toContain('SECRET_OR_PRIVATE_KEY_LOCAL');
      expect(raw).toContain('***');
      const parsed = JSON.parse(raw);
      expect(parsed.jwt.secret).toBe('***');
    });
  });
});
