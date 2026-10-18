/**
 * Where the MCP OAuth endpoints live in a real Nest application, and what they advertise.
 *
 * The endpoints are an Express router, not Nest routes. The documentation used to say "mount it
 * after `app.init()`", and that never worked: Nest registers its not-found handler inside `init()`,
 * so a router added afterwards was never reached and every OAuth endpoint answered 404. Tests built
 * on a bare express app could not see that — there is no not-found handler to be behind. These
 * boot a Nest application, so they can.
 *
 * Since 11.43.0 `CoreAiMcpOAuthInitializer` mounts the router during `app.init()` (`onModuleInit`):
 * behind the Nest middleware and routes, ahead of the not-found handler. It describes the MCP
 * endpoint at the path Nest actually registered, and the endpoint's 401 points at exactly the
 * metadata document the router serves.
 *
 * No MongoDB: the OAuth stores run on the in-memory connection, the MCP service is a stub (no case
 * gets past authentication).
 */
import {
  INestApplication,
  Logger,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
  Type,
  VERSION_NEUTRAL,
  VersioningType,
} from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreAiMcpOAuthInitializer } from '../../src/core/modules/ai/core-ai-mcp-oauth.initializer';
import { CoreAiMcpController } from '../../src/core/modules/ai/core-ai-mcp.controller';
import { CoreAiModule } from '../../src/core/modules/ai/core-ai.module';
import { mountAiMcpOAuth, mountAiMcpOAuthRouter } from '../../src/core/modules/ai/helpers/ai-mcp-oauth.helper';
import { getMountedMcpOAuth } from '../../src/core/modules/ai/helpers/ai-mcp-oauth.registry';
import { setBetterAuthTokenService } from '../../src/core/modules/better-auth/core-better-auth.registry';
import { CoreAiMcpOAuthService } from '../../src/core/modules/ai/services/core-ai-mcp-oauth.service';
import { CoreAiMcpService } from '../../src/core/modules/ai/services/core-ai-mcp.service';
import { createMcpOAuthMemoryConnection } from '../helpers/mcp-oauth-memory-connection';

const BASE_URL = 'https://api.example.com';
const REDIRECT_URI = 'https://app.example.com/callback';
const CODE_VERIFIER = 'mcp-oauth-lifecycle-code-verifier-0123456789abcdefghij';
const CODE_CHALLENGE = createHash('sha256').update(CODE_VERIFIER).digest('base64url');

/** A consent step that signs in a fixed user — the shape a project's override takes. */
/**
 * The consent shape the documentation prescribes: GET shows what is being authorized, only the
 * user's POST approval issues a code. (The CSRF token a real consent page carries is reduced to a
 * fixed field here.)
 */
class ConsentingOAuthService extends CoreAiMcpOAuthService {
  protected override async authorizeConsent(client: any, params: any, res: any): Promise<void> {
    const req = res.req;
    if (req.method !== 'POST') {
      res
        .status(200)
        .send(`Allow ${client.client_name} to act for you? The code goes to ${new URL(params.redirectUri).host}.`);
      return;
    }
    if (req.body?.csrf !== 'csrf-ok' || req.body?.decision !== 'approve') {
      const { AccessDeniedError } = await this.loadOAuthErrors();
      throw new AccessDeniedError('The user declined');
    }
    const code = this.generateId();
    await this.saveAuthorizationCode(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      userId: 'user-1',
    });
    const target = new URL(params.redirectUri);
    target.searchParams.set('code', code);
    if (params.state) {
      target.searchParams.set('state', params.state);
    }
    res.redirect(target.href);
  }
}

/** The shape the documentation used to describe: a signed-in session taken as consent, code issued on GET. */
class IssuingOnGetOAuthService extends CoreAiMcpOAuthService {
  protected override async authorizeConsent(client: any, params: any, res: any): Promise<void> {
    const code = this.generateId();
    await this.saveAuthorizationCode(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      userId: 'victim',
    });
    const target = new URL(params.redirectUri);
    target.searchParams.set('code', code);
    res.redirect(target.href);
  }
}

/** A subclass whose lifecycle hook forgets `super` — and with it the boot-time secret check. */
class SkippingInitOAuthService extends CoreAiMcpOAuthService {
  override onModuleInit(): void {
    // intentionally no super.onModuleInit()
  }
}

function useConfig(
  overrides: {
    apiTokens?: unknown;
    appUrl?: string;
    baseUrl?: string;
    env?: string;
    mcp?: Record<string, unknown>;
  } = {},
): void {
  const { mcp, ...rest } = overrides;
  ConfigService.setConfig(
    {
      ai: { mcp: { oauth: true, oauthSecret: 'unit-mcp-oauth-lifecycle-secret-32chars!', ...mcp } },
      baseUrl: BASE_URL,
      env: 'production',
      ...rest,
    } as any,
    { reInit: true, warn: false },
  );
}

/** The module a project's AI module amounts to here, plus a Nest middleware to see where the router sits. */
function mcpModule(service: Type<CoreAiMcpOAuthService>) {
  @Module({
    controllers: [CoreAiMcpController],
    providers: [
      { provide: getConnectionToken(), useValue: createMcpOAuthMemoryConnection() },
      { provide: CoreAiMcpService, useValue: {} },
      { provide: CoreAiMcpOAuthService, useClass: service },
      CoreAiMcpOAuthInitializer,
    ],
  })
  class McpTestModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer
        .apply((req: any, res: any, next: () => void) => {
          res.setHeader('x-nest-middleware', 'ran');
          // Stands in for the Better-Auth middleware, which puts the session user on every request.
          const user = req.headers['x-test-user'];
          if (typeof user === 'string') {
            req.user = JSON.parse(user);
          }
          next();
        })
        .forRoutes({ method: RequestMethod.ALL, path: '*path' });
    }
  }
  return McpTestModule;
}

let app: INestApplication | undefined;

/** Builds the app; `configure` runs before `app.init()`, where `main.ts` would set prefix or versioning. */
async function boot(
  options: {
    configure?: (app: INestApplication) => void | Promise<void>;
    routerPath?: string;
    service?: Type<CoreAiMcpOAuthService>;
  } = {},
): Promise<INestApplication> {
  const module = mcpModule(options.service ?? CoreAiMcpOAuthService);
  const imports = options.routerPath
    ? [module, RouterModule.register([{ module, path: options.routerPath }])]
    : [module];
  const fixture = await Test.createTestingModule({ imports }).compile();
  app = fixture.createNestApplication();
  await options.configure?.(app);
  await app.init();
  return app;
}

const http = () => request(app!.getHttpServer());

describe('MCP OAuth endpoints — mounted by CoreModule inside app.init()', () => {
  beforeEach(() => useConfig());

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await app?.close();
    app = undefined;
  });

  /**
   * @regression   11.42.16 and earlier — the router was mounted after `app.init()` (as documented),
   *   behind Nest's not-found handler, so every OAuth endpoint answered 404.
   * @seen-failing Registered as `mcp-oauth-mounted-after-not-found-handler` in
   *   tests/regression-mutations.json — mounting in onApplicationBootstrap (after the not-found
   *   handler) turns this red.
   */
  it('answers discovery and token requests on an initialized app, behind the Nest middleware', async () => {
    await boot();

    const metadata = await http().get('/.well-known/oauth-authorization-server');
    expect(metadata.status).toBe(200);
    expect(metadata.body.issuer).toBe(`${BASE_URL}/`);
    expect(metadata.body.token_endpoint).toBe(`${BASE_URL}/token`);
    // Behind the Nest middleware: what a project applies to every route reaches these responses too.
    expect(metadata.headers['x-nest-middleware']).toBe('ran');

    const token = await http()
      .post('/token')
      .type('form')
      .send({ client_id: 'unknown', grant_type: 'refresh_token', refresh_token: 'x' });
    expect(token.status).toBe(400);
    expect(token.body.error).toBe('invalid_client');
  });

  it('mounts nothing without ai.mcp.oauth, and the MCP 401 then advertises no metadata', async () => {
    useConfig({ mcp: { oauth: false } });
    await boot();

    expect((await http().get('/.well-known/oauth-authorization-server')).status).toBe(404);
    expect(getMountedMcpOAuth()).toBeUndefined();
    const unauthorized = await http().post('/ai/mcp').send({});
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers['www-authenticate']).toBe('Bearer');
  });

  it('mounts nothing in an application context without an HTTP server', async () => {
    const fixture = await Test.createTestingModule({ imports: [mcpModule(CoreAiMcpOAuthService)] }).compile();
    await expect(fixture.init()).resolves.toBeDefined();
    expect(getMountedMcpOAuth()).toBeUndefined();
    await fixture.close();
  });

  it('fails the boot in a deployed environment without a public URL, rather than guessing one', async () => {
    useConfig({ baseUrl: undefined, env: 'production' });
    await expect(boot()).rejects.toThrow(/NSC__BASE_URL|oauthBaseUrl/);
  });

  it('uses ai.mcp.oauthBaseUrl as issuer and resource host when set', async () => {
    useConfig({ mcp: { oauthBaseUrl: 'https://mcp.example.org' } });
    await boot();

    expect((await http().get('/.well-known/oauth-authorization-server')).body.issuer).toBe('https://mcp.example.org/');
    expect((await http().get('/.well-known/oauth-protected-resource/ai/mcp')).body.resource).toBe(
      'https://mcp.example.org/ai/mcp',
    );
  });

  /**
   * @regression   The MCP resource was always described as `/ai/mcp`, so under a global prefix the
   *   protected resource metadata named a URL the MCP endpoint does not answer on, and the 401
   *   pointed at the endpoint itself instead of at the metadata (RFC 9728 §5.1).
   * @seen-failing Registered as `mcp-oauth-resource-ignores-global-prefix` and
   *   `mcp-oauth-401-names-endpoint-not-metadata` in tests/regression-mutations.json.
   */
  it.each([
    { expected: '/ai/mcp', name: 'no prefix' },
    { configure: (a: INestApplication) => a.setGlobalPrefix('api'), expected: '/api/ai/mcp', name: 'global prefix' },
    {
      configure: (a: INestApplication) =>
        a.setGlobalPrefix('api', { exclude: [{ method: RequestMethod.ALL, path: 'ai/mcp' }] }),
      expected: '/ai/mcp',
      name: 'global prefix excluding the MCP route',
    },
    {
      configure: (a: INestApplication) => a.enableVersioning({ defaultVersion: '1', type: VersioningType.URI }),
      expected: '/v1/ai/mcp',
      name: 'URI versioning',
    },
    {
      configure: (a: INestApplication) =>
        a.enableVersioning({ defaultVersion: VERSION_NEUTRAL, type: VersioningType.URI }),
      expected: '/ai/mcp',
      name: 'URI versioning, version-neutral default',
    },
    {
      configure: (a: INestApplication) => {
        a.setGlobalPrefix('api');
        a.enableVersioning({ defaultVersion: '2', type: VersioningType.URI });
      },
      expected: '/api/v2/ai/mcp',
      name: 'global prefix and URI versioning',
    },
    { expected: '/tools/ai/mcp', name: 'RouterModule path', routerPath: 'tools' },
  ])('describes the MCP endpoint where Nest registered it ($name)', async ({ configure, expected, routerPath }) => {
    await boot({ configure, routerPath });

    // The endpoint really is there: it answers the unauthenticated POST itself, with its own 401.
    const unauthorized = await http().post(expected).send({});
    expect(unauthorized.status).toBe(401);

    const metadataUrl = `${BASE_URL}/.well-known/oauth-protected-resource${expected}`;
    expect(unauthorized.headers['www-authenticate']).toBe(`Bearer resource_metadata="${metadataUrl}"`);

    const metadata = await http().get(new URL(metadataUrl).pathname);
    expect(metadata.status).toBe(200);
    expect(metadata.body.resource).toBe(`${BASE_URL}${expected}`);
    expect(metadata.body.authorization_servers).toEqual([`${BASE_URL}/`]);
  });

  /**
   * @regression   A mountAiMcpOAuth() call left in main.ts after upgrading must not mount a second
   *   router or replace what the 401 and Swagger describe — and must say which options it ignored.
   * @seen-failing Registered as `mcp-oauth-redundant-call-silent` in tests/regression-mutations.json.
   */
  it('turns a mountAiMcpOAuth() call after app.init() into a no-op that names what it ignored', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await boot();

    await mountAiMcpOAuth(app!, { baseUrl: 'https://other.example.org', mcpPath: '/other/mcp' });

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/already mounted.*ignored baseUrl.*mcpPath/s));
    expect((await http().get('/.well-known/oauth-authorization-server')).body.issuer).toBe(`${BASE_URL}/`);
    expect(getMountedMcpOAuth()?.resourceMetadataUrl).toBe(`${BASE_URL}/.well-known/oauth-protected-resource/ai/mcp`);
  });

  /**
   * @regression   A project that mounted the router itself before app.init() keeps that router;
   *   CoreModule must not add a second one and take over what the 401 advertises.
   * @seen-failing Registered as `mcp-oauth-second-mount-replaces-first` in
   *   tests/regression-mutations.json.
   */
  it('keeps a router mounted before app.init() and adds no second one', async () => {
    await boot({ configure: (a) => mountAiMcpOAuth(a, { baseUrl: 'https://manual.example.org' }) });

    expect((await http().get('/.well-known/oauth-authorization-server')).body.issuer).toBe(
      'https://manual.example.org/',
    );
    const unauthorized = await http().post('/ai/mcp').send({});
    expect(unauthorized.headers['www-authenticate']).toBe(
      'Bearer resource_metadata="https://manual.example.org/.well-known/oauth-protected-resource/ai/mcp"',
    );
  });

  /** Registers a public client and returns its id plus the OAuth parameters of an authorization request. */
  async function authorizationRequest() {
    const registered = await http()
      .post('/register')
      .send({ client_name: 'MCP client', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' });
    expect(registered.status).toBe(201);
    const clientId: string = registered.body.client_id;
    return {
      clientId,
      params: {
        client_id: clientId,
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: 'S256',
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        state: 'state-1',
      },
    };
  }

  it('runs the authorization code flow through the registered service subclass', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await boot({ service: ConsentingOAuthService });
    // A consent of its own needs no Better-Auth, so nothing is reported.
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/Better-Auth is not active/));
    const { clientId, params } = await authorizationRequest();

    // GET shows the consent page; nothing is authorized yet.
    const consentPage = await http().get('/authorize').query(params);
    expect(consentPage.status).toBe(200);
    expect(consentPage.text).toContain('MCP client');
    expect(consentPage.text).toContain(new URL(REDIRECT_URI).host);

    // Declining sends the client back with access_denied.
    const declined = await http()
      .post('/authorize')
      .type('form')
      .send({ ...params, csrf: 'csrf-ok', decision: 'decline' });
    expect(declined.status).toBe(302);
    expect(new URL(declined.headers.location).searchParams.get('error')).toBe('access_denied');

    // The approving POST issues the code.
    const authorized = await http()
      .post('/authorize')
      .type('form')
      .send({ ...params, csrf: 'csrf-ok', decision: 'approve' });
    expect(authorized.status).toBe(302);
    const redirect = new URL(authorized.headers.location);
    expect(redirect.searchParams.get('state')).toBe('state-1');
    const code = redirect.searchParams.get('code');
    expect(code).toBeTruthy();

    const tokens = await http()
      .post('/token')
      .type('form')
      .send({ client_id: clientId, code: code!, code_verifier: CODE_VERIFIER, grant_type: 'authorization_code' });
    expect(tokens.status).toBe(200);
    const service = app!.get(CoreAiMcpOAuthService);
    expect(service).toBeInstanceOf(ConsentingOAuthService);
    expect(service.verifyAccessToken(tokens.body.access_token)?.sub).toBe('user-1');

    const refreshed = await http()
      .post('/token')
      .type('form')
      .send({ client_id: clientId, grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).toBeTruthy();
  });

  /**
   * @regression   11.43.0 (pre-release review) — a consent that issued the code on GET (what the
   *   documentation described: signed in, save the code, redirect) let any link a signed-in user
   *   opened authorize an attacker's client: the attacker registers a client with its own redirect
   *   URI and starts the flow, so PKCE is the attacker's too, and redeems the code for the user's
   *   MCP access. A code issued while answering /authorize must come from a POST.
   * @seen-failing Registered as `mcp-oauth-code-issued-on-get` in tests/regression-mutations.json.
   */
  it('refuses to issue an authorization code while answering a GET to /authorize', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await boot({ service: IssuingOnGetOAuthService });
    const { params } = await authorizationRequest();

    const response = await http().get('/authorize').query(params);

    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.location);
    expect(redirect.searchParams.get('code')).toBeNull();
    expect(redirect.searchParams.get('error')).toBe('server_error');
    const connection = app!.get(getConnectionToken());
    expect(connection.db.collection('aiMcpOAuthCodes').docs).toHaveLength(0);
    // The SDK answers the refusal with a bare server_error; the server log says why.
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/refused to issue an authorization code while answering GET/),
    );
  });

  /**
   * @regression   11.43.0 (pre-release review) — a subclass whose onModuleInit() skips super also
   *   skipped the production secret check, and tokens were then signed with the public development
   *   default: forgeable by anyone.
   * @seen-failing Registered as `mcp-oauth-initializer-skips-secret-check` and
   *   `mcp-oauth-dev-secret-in-production` in tests/regression-mutations.json.
   */
  it('refuses to run without a signing secret in production, even when a subclass skips its own check', async () => {
    // Pinned, not inherited: either variable is a secret source, and a runner may set one.
    vi.stubEnv('NSC__AI__ENCRYPTION_SECRET', '');
    vi.stubEnv('SECRETS_ENCRYPTION_KEY', '');
    useConfig({ mcp: { oauthSecret: undefined } });
    await expect(boot({ service: SkippingInitOAuthService })).rejects.toThrow(/signing secret/);

    // The backstop below the boot check: no token is signed with the public default.
    expect(() => new SkippingInitOAuthService({} as any).signAccessToken('user-1', 'client-1')).toThrow(
      /public development default/,
    );
  });

  /**
   * @regression   11.43.0 (review) — the public development key was refused only in `production`
   *   and `staging`. A starter-based project DEPLOYS `develop` and `test` stages; with `ai.mcp.oauth`
   *   on and no secret there, anybody who knew a user id could forge that user's MCP access token.
   * @seen-failing Registered as `mcp-oauth-dev-secret-on-deployed-stage` in
   *   tests/regression-mutations.json.
   */
  it.each(['develop', 'test', 'production'])(
    'refuses to boot without a signing secret on the deployed stage %s',
    async (env) => {
      vi.stubEnv('NSC__AI__ENCRYPTION_SECRET', '');
      vi.stubEnv('SECRETS_ENCRYPTION_KEY', '');
      useConfig({ env, mcp: { oauthSecret: undefined } });
      await expect(boot()).rejects.toThrow(/signing secret is required/);
    },
  );

  it.each(['local', 'ci', 'e2e'])('keeps the development key working in the local environment %s', async (env) => {
    vi.stubEnv('NSC__AI__ENCRYPTION_SECRET', '');
    vi.stubEnv('SECRETS_ENCRYPTION_KEY', '');
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    useConfig({ env, mcp: { oauthSecret: undefined } });
    await boot();
    const token = app!.get(CoreAiMcpOAuthService).signAccessToken('user-1', 'client-1');
    expect(app!.get(CoreAiMcpOAuthService).verifyAccessToken(token)?.sub).toBe('user-1');
  });

  it('warns at boot when the built-in consent page has no Better-Auth to sign users in with', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await boot();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Better-Auth is not active/));
  });

  it('does not warn when Better-Auth is active or a consent of its own is registered', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    setBetterAuthTokenService({} as any);
    try {
      await boot();
    } finally {
      setBetterAuthTokenService(null);
    }
    await app!.close();
    app = undefined;
    await boot({ service: ConsentingOAuthService });
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/Better-Auth is not active/));
  });

  describe('built-in consent page', () => {
    const user = { email: 'ada@example.com', id: 'user-ada', roles: [] };
    const signedIn = (who: object = user) => ({ 'x-test-user': JSON.stringify(who) });

    beforeEach(() => setBetterAuthTokenService({} as any));
    afterEach(() => setBetterAuthTokenService(null));

    /** The hidden fields and the CSRF token of a rendered consent form. */
    function formOf(html: string): Record<string, string> {
      const fields: Record<string, string> = {};
      for (const [, name, value] of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
        fields[name] = value
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>');
      }
      return fields;
    }

    async function consentPage(headers: Record<string, string> = signedIn()) {
      const { clientId, params } = await authorizationRequest();
      const page = await http().get('/authorize').query(params).set(headers);
      return { clientId, page, params };
    }

    const issuedCodes = () => app!.get(getConnectionToken()).db.collection('aiMcpOAuthCodes').docs;

    /**
     * @regression   11.43.0 (pre-release review) — the sign-in form had no method, so without the
     *   script (blocked by an extension or a second CSP from a proxy) Enter submitted it by GET and put
     *   the password into the URL: browser history, proxy and APM logs.
     * @seen-failing Registered as `mcp-oauth-consent-password-form-get` in tests/regression-mutations.json.
     */
    it('shows the sign-in view to a visitor without a session, with Better-Auth as the way in', async () => {
      useConfig({ appUrl: 'https://crm.example.com' });
      await boot();
      const { page } = await consentPage({});

      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toMatch(/text\/html/);
      expect(page.text).toContain('id="lt-mcp-signin"');
      expect(page.text).toContain('data-auth-base="/iam"');
      expect(page.text).not.toContain('lt_mcp_csrf');
      // Without the script nothing can be submitted, and never by GET (the password would land in the URL).
      expect(page.text).toContain('<form id="lt-mcp-password" method="post" hidden>');
      expect(page.text).toContain('href="https://crm.example.com/auth/login"');
      // The script runs under the CSP nonce of this response, and nothing else does.
      const nonce = /script-src 'nonce-([^']+)'/.exec(page.headers['content-security-policy'])?.[1];
      expect(nonce).toBeTruthy();
      expect(page.text).toContain(`<script nonce="${nonce}">`);
    });

    it('offers no sign-in form when Better-Auth is not active', async () => {
      setBetterAuthTokenService(null);
      await boot();
      const { page } = await consentPage({});

      expect(page.status).toBe(200);
      expect(page.text).not.toContain('lt-mcp-signin');
      expect(page.text).not.toContain('<script');
      expect(page.text).toContain('not set up on this server');
    });

    /**
     * @regression   11.43.0 (pre-release) — the client's name comes from dynamic registration, i.e.
     *   from whoever registered the client; rendered unescaped it runs script on the API origin.
     * @seen-failing Registered as `mcp-oauth-consent-client-name-unescaped` and
     *   `mcp-oauth-consent-frameable` (a framed page lets a hostile site overlay the Allow button) in
     *   tests/regression-mutations.json.
     */
    it('shows a signed-in user which client asks and where the code goes, escaped and unframeable', async () => {
      await boot();
      const registered = await http()
        .post('/register')
        .send({
          client_name: '<img src=x onerror=alert(1)> {app}',
          redirect_uris: ['https://evil.example/cb'],
          token_endpoint_auth_method: 'none',
        });
      const page = await http().get('/authorize').set(signedIn()).query({
        client_id: registered.body.client_id,
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: 'S256',
        redirect_uri: 'https://evil.example/cb',
        response_type: 'code',
        state: 's"1',
      });

      expect(page.status).toBe(200);
      expect(page.text).not.toContain('<img src=x');
      expect(page.text).toContain('&lt;img src=x onerror=alert(1)&gt; {app}');
      expect(page.text).toContain('<strong>evil.example</strong>');
      expect(page.text).toContain('ada@example.com');
      expect(page.text).toContain('value="s&quot;1"');
      // Allow is disabled in the HTML; only the guard script (under this response's nonce) arms it.
      expect(page.text).toMatch(/<button[^>]*value="approve"[^>]*id="lt-mcp-allow" disabled>/);
      const nonce = /script-src 'nonce-([^']+)'/.exec(page.headers['content-security-policy'])?.[1];
      expect(page.text).toContain(`<script nonce="${nonce}">`);
      expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(page.headers['x-frame-options']).toBe('DENY');
      expect(page.headers['cache-control']).toBe('no-store');
    });

    it('speaks German to a German browser', async () => {
      await boot();
      const { params } = await authorizationRequest();
      const page = await http()
        .get('/authorize')
        .query(params)
        .set({ ...signedIn(), 'accept-language': 'de-DE,de;q=0.9' });
      expect(page.text).toContain('Zulassen');
      expect(page.text).toContain('<html lang="de">');
    });

    it("issues the code on Allow and completes the flow; the code is the signed-in user's", async () => {
      await boot();
      const { clientId, page } = await consentPage();
      const form = formOf(page.text);

      const approved = await http()
        .post('/authorize')
        .set(signedIn())
        .type('form')
        .send({ ...form, lt_mcp_consent: 'approve' });

      expect(approved.status).toBe(302);
      const redirect = new URL(approved.headers.location);
      expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
      expect(redirect.searchParams.get('state')).toBe('state-1');
      const tokens = await http()
        .post('/token')
        .type('form')
        .send({
          client_id: clientId,
          code: redirect.searchParams.get('code')!,
          code_verifier: CODE_VERIFIER,
          grant_type: 'authorization_code',
        });
      expect(tokens.status).toBe(200);
      expect(app!.get(CoreAiMcpOAuthService).verifyAccessToken(tokens.body.access_token)?.sub).toBe('user-ada');
    });

    it('sends the client back with access_denied on Deny', async () => {
      await boot();
      const { page } = await consentPage();

      const denied = await http()
        .post('/authorize')
        .set(signedIn())
        .type('form')
        .send({ ...formOf(page.text), lt_mcp_consent: 'deny' });

      expect(denied.status).toBe(302);
      expect(new URL(denied.headers.location).searchParams.get('error')).toBe('access_denied');
      expect(issuedCodes()).toHaveLength(0);
    });

    /**
     * @regression   The CSRF token is what makes Allow the user's own decision: it must be checked,
     *   and bound to the user, the client, the redirect URI and the PKCE challenge.
     * @seen-failing Registered as `mcp-oauth-consent-token-unchecked`,
     *   `mcp-oauth-consent-token-not-user-bound` and `mcp-oauth-consent-challenge-not-bound` in
     *   tests/regression-mutations.json.
     */
    it.each([
      {
        change: (form: Record<string, string>) => ({ ...form, lt_mcp_csrf: '9999999999.forged' }),
        name: 'a forged token',
      },
      { change: (form: Record<string, string>) => ({ ...form, lt_mcp_csrf: '' }), name: 'no token' },
      {
        change: (form: Record<string, string>) => ({
          ...form,
          code_challenge: createHash('sha256').update('attacker').digest('base64url'),
        }),
        name: 'a swapped PKCE challenge',
      },
      {
        as: { email: 'eve@example.com', id: 'user-eve' },
        change: (form: Record<string, string>) => form,
        name: "another user's token",
      },
    ])('issues no code for $name, and shows the form again', async ({ as, change }) => {
      const warn = vi.spyOn(Logger.prototype, 'warn');
      await boot();
      const { page } = await consentPage();

      const response = await http()
        .post('/authorize')
        .set(signedIn(as ?? user))
        .type('form')
        .send({ ...change(formOf(page.text)), lt_mcp_consent: 'approve' });

      expect(response.status).toBe(200);
      expect(response.text).toContain('lt_mcp_csrf');
      expect(issuedCodes()).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invalid token/));
    });

    /**
     * @regression   11.43.0 (pre-release review) — the token must also be bound to the client and to
     *   the redirect URI: otherwise a token from one client's consent page approves another client,
     *   or sends the code to another registered redirect URI than the one the user was shown.
     * @seen-failing Registered as `mcp-oauth-consent-client-not-bound` and
     *   `mcp-oauth-consent-redirect-not-bound` in tests/regression-mutations.json.
     */
    it('issues no code when the approving POST names another client or another redirect URI', async () => {
      await boot();
      const register = async (redirectUris: string[]) =>
        (
          await http()
            .post('/register')
            .send({ client_name: 'Client', redirect_uris: redirectUris, token_endpoint_auth_method: 'none' })
        ).body.client_id as string;
      const otherRedirect = 'https://app.example.com/other';
      const clientA = await register([REDIRECT_URI, otherRedirect]);
      const clientB = await register([REDIRECT_URI]);
      const params = {
        client_id: clientA,
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: 'S256',
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
      };
      const form = formOf((await http().get('/authorize').query(params).set(signedIn())).text);
      const approve = (changes: Record<string, string>) =>
        http()
          .post('/authorize')
          .set(signedIn())
          .type('form')
          .send({ ...form, ...changes, lt_mcp_consent: 'approve' });

      const otherClient = await approve({ client_id: clientB });
      const otherTarget = await approve({ redirect_uri: otherRedirect });

      expect(otherClient.status).toBe(200);
      expect(otherTarget.status).toBe(200);
      expect(issuedCodes()).toHaveLength(0);
    });

    it('shows the form again with a notice when the page was open for too long', async () => {
      await boot();
      const { page } = await consentPage();
      const later = Date.now() + 11 * 60 * 1000;
      vi.spyOn(Date, 'now').mockReturnValue(later);

      const response = await http()
        .post('/authorize')
        .set(signedIn())
        .type('form')
        .send({ ...formOf(page.text), lt_mcp_consent: 'approve' });

      expect(response.status).toBe(200);
      expect(response.text).toContain('open for too long');
      expect(issuedCodes()).toHaveLength(0);
    });

    it('issues nothing for an Allow without a session, and asks to sign in', async () => {
      await boot();
      const { page } = await consentPage();

      const response = await http()
        .post('/authorize')
        .type('form')
        .send({ ...formOf(page.text), lt_mcp_consent: 'approve' });

      expect(response.status).toBe(200);
      expect(response.text).toContain('id="lt-mcp-signin"');
      expect(issuedCodes()).toHaveLength(0);
    });

    /**
     * @regression   11.43.0 (review) — under a global prefix Nest registers the Better-Auth middleware
     *   below the prefix while the OAuth router sits at the root: /authorize never saw the session, and
     *   the sign-in view posted to `/iam` instead of `/api/iam` (404) — nobody could authorize a client.
     * @seen-failing Registered as `mcp-oauth-consent-ignores-session-under-prefix`,
     *   `mcp-oauth-consent-auth-path-ignores-prefix` and `mcp-oauth-consent-api-token-via-session-lookup`
     *   in tests/regression-mutations.json.
     */
    it('recognizes the session below a global prefix, signs in there, and never takes an API token for a user', async () => {
      // A token service that would accept ANY credential: only the API-token guard stands between an
      // API token and a consent.
      setBetterAuthTokenService({
        extractTokenFromRequest: (req: any) => ({
          token: req.headers.authorization?.replace(/^bearer /i, '') ?? req.headers['x-session'] ?? null,
        }),
        verifyAndLoadUser: async () => ({ email: user.email, id: user.id }),
      } as any);
      useConfig({ apiTokens: true });
      await boot({
        configure: (a) => {
          a.setGlobalPrefix('api');
        },
      });
      const { params } = await authorizationRequest();

      // The test middleware stands in for Better-Auth's and is prefixed too, so it does not run here.
      const withSession = await http().get('/authorize').query(params).set('x-session', 'session-ada');
      expect(withSession.text).toContain('lt_mcp_csrf');
      expect(withSession.text).toContain(user.email);

      const anonymous = await http().get('/authorize').query(params);
      expect(anonymous.text).toContain('data-auth-base="/api/iam"');

      const apiToken = `ltt_${'a'.repeat(24)}_${'b'.repeat(64)}`;
      const withApiToken = await http().get('/authorize').query(params).set('authorization', `Bearer ${apiToken}`);
      expect(withApiToken.text).not.toContain('lt_mcp_csrf');
    });

    it('links a login page that returns by itself when ai.mcp.oauthLoginUrl carries {returnTo}', async () => {
      useConfig({ mcp: { oauthLoginUrl: 'https://crm.example.com/auth/login?redirect={returnTo}' } });
      await boot();
      const { page } = await consentPage({});

      const href = /<a href="([^"]+)">/.exec(page.text)?.[1].replace(/&amp;/g, '&');
      const returnTo = new URL(href!).searchParams.get('redirect');
      expect(new URL(returnTo!).origin + new URL(returnTo!).pathname).toBe(`${BASE_URL}/authorize`);
      expect(new URL(returnTo!).searchParams.get('client_id')).toBeTruthy();
      expect(page.text).not.toContain('target="_blank"');
    });
  });
});

describe('mountAiMcpOAuthRouter — once per app', () => {
  beforeEach(() => useConfig());

  const service = () => new CoreAiMcpOAuthService(createMcpOAuthMemoryConnection() as any);

  it('mounts one router for two concurrent calls on the same app', async () => {
    const target = {};
    const use = vi.fn();
    const options = { mcpPath: '/ai/mcp' };

    const [first, second] = await Promise.all([
      mountAiMcpOAuthRouter(target, use, service(), options),
      mountAiMcpOAuthRouter(target, use, service(), options),
    ]);

    expect(use).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('lets a later call mount after a failed one', async () => {
    const target = {};
    const use = vi.fn();
    useConfig({ baseUrl: undefined, env: 'production' });
    await expect(mountAiMcpOAuthRouter(target, use, service(), { mcpPath: '/ai/mcp' })).rejects.toThrow(
      /NSC__BASE_URL/,
    );

    useConfig();
    await expect(mountAiMcpOAuthRouter(target, use, service(), { mcpPath: '/ai/mcp' })).resolves.toMatchObject({
      issuerUrl: `${BASE_URL}/`,
    });
    expect(use).toHaveBeenCalledTimes(1);
  });

  it('ignores an oauthBaseUrl that is not a string instead of failing on it', async () => {
    useConfig({ mcp: { oauthBaseUrl: 42 } });
    await expect(
      mountAiMcpOAuthRouter({}, vi.fn(), service(), { baseUrl: 42, mcpPath: '/ai/mcp' }),
    ).resolves.toMatchObject({ issuerUrl: `${BASE_URL}/` });
  });
});

describe('CoreAiModule.forRoot — MCP OAuth wiring', () => {
  const providersOf = (options: Parameters<typeof CoreAiModule.forRoot>[0]) =>
    CoreAiModule.forRoot(options).providers ?? [];

  /**
   * @regression   CoreAiModule offered no way to register a CoreAiMcpOAuthService subclass, so a
   *   project's authorizeConsent() could not reach the endpoints or the MCP controller.
   * @seen-failing Registered as `mcp-oauth-override-not-bound` in tests/regression-mutations.json.
   */
  it('binds mcpOAuthService to the base token and registers the initializer with the MCP endpoint', () => {
    const providers = providersOf({ mcpEnabled: true, mcpOAuthService: ConsentingOAuthService });

    expect(providers).toContainEqual({ provide: CoreAiMcpOAuthService, useClass: ConsentingOAuthService });
    expect(providers).toContain(CoreAiMcpOAuthInitializer);
  });

  it('keeps the base service and registers no initializer without the MCP endpoint', () => {
    const providers = providersOf({});

    expect(providers).toContainEqual({ provide: CoreAiMcpOAuthService, useClass: CoreAiMcpOAuthService });
    expect(providers).not.toContain(CoreAiMcpOAuthInitializer);
  });
});
