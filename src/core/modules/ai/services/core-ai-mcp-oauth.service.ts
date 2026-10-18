import type * as OAuthErrors from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Connection } from 'mongoose';

import { isLocalEnv, resolveAppUrlFromConfig } from '../../../common/helpers/cookies.helper';
import { ConfigService } from '../../../common/services/config.service';
import { getApiTokenContext, hasApiTokenCredential } from '../../api-token/core-api-token.helpers';
import { getBetterAuthTokenService } from '../../better-auth/core-better-auth.registry';
import {
  IMcpOAuthConsentView,
  MCP_OAUTH_CONSENT_DECISION_FIELD,
  MCP_OAUTH_CONSENT_TOKEN_FIELD,
  mcpOAuthConsentHeaders,
  mcpOAuthConsentLocale,
  renderMcpOAuthConsentPage,
} from '../helpers/ai-mcp-oauth-consent.helper';
import { getMountedMcpOAuth } from '../helpers/ai-mcp-oauth.registry';

/**
 * Stored OAuth client (dynamically registered).
 *
 * For confidential clients (i.e. clients that registered with a
 * `token_endpoint_auth_method` other than `'none'`), `client_secret` is
 * persisted and returned here so the SDK's `clientAuth` middleware can verify
 * it. Dropping the secret from the returned shape would silently downgrade
 * confidential clients to public clients (the SDK's secret-verification branch
 * is gated by `if (client.client_secret)`).
 */
export interface AiMcpOAuthClient {
  client_id: string;
  client_name?: string;
  client_secret?: string;
  client_secret_expires_at?: number;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
}

/**
 * Decoded MCP access-token payload.
 */
export interface AiMcpAccessTokenPayload {
  cid: string;
  exp: number;
  sub: string;
  type: 'mcp_access';
}

/**
 * What a consent form's CSRF token is bound to: who approves, which client, where the code goes,
 * and the PKCE challenge — so neither a token from another user's page nor a form with swapped
 * parameters can issue a code.
 */
export interface IAiMcpOAuthConsentBinding {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  userId: string;
}

/**
 * The HTTP method of the `/authorize` request a consent step is answering, while it answers it.
 *
 * Set by the provider's `authorize` (outside the overridable {@link CoreAiMcpOAuthService.authorizeConsent}),
 * read by {@link assertCodeIssuanceAllowed}.
 */
const authorizeRequest = new AsyncLocalStorage<{ method: string }>();

/**
 * Refuses to issue an authorization code while answering a GET to `/authorize`.
 *
 * A GET is what a link, an image or a redirect produces, and it carries the user's session cookie
 * (SameSite=Lax). Anybody may register a client with their own redirect URI and start the flow, so
 * PKCE is theirs too. A consent that issues on GET therefore hands a code for whoever opens the
 * attacker's link to the attacker, who redeems it for that user's MCP access. The code must come
 * from a POST: the form in which the user approved this client. A code saved outside the
 * `/authorize` handler (e.g. by a consent route of the project's own) is not affected; that route
 * carries the same obligation.
 */
function assertCodeIssuanceAllowed(): void {
  const request = authorizeRequest.getStore();
  if (request && request.method !== 'POST') {
    const message =
      `MCP OAuth: refused to issue an authorization code while answering ${request.method || 'a non-POST'} /authorize. ` +
      'Show the consent page on GET and issue the code only when the user approves it with a POST.';
    // Logged here because the SDK turns the error into a bare `error=server_error` redirect and says
    // nothing server-side: without this line a consent implemented the wrong way fails silently.
    new Logger('CoreAiMcpOAuthService').error(message);
    throw new Error(message);
  }
}

/**
 * What a consent token signs. JSON, so no value can run into the next; the leading `[` keeps it
 * apart from the access tokens' input (base64url, never a `[`), which use the same key.
 */
function consentTokenPayload(binding: IAiMcpOAuthConsentBinding, exp: number): string {
  return JSON.stringify([
    'mcp_consent',
    binding.userId,
    binding.clientId,
    binding.redirectUri,
    binding.codeChallenge,
    exp,
  ]);
}

/**
 * Security core for the MCP OAuth 2.1 flow.
 *
 * Implements the security-critical primitives — HMAC-signed access tokens
 * (constant-time verification), PKCE (S256) verification — and MongoDB-backed
 * stores for dynamically registered clients, authorization codes (TTL) and
 * refresh tokens. These power the SDK `OAuthServerProvider` returned by
 * {@link buildOAuthProvider}, which `CoreAiMcpOAuthInitializer` mounts as `mcpAuthRouter`
 * when `ai.mcp.oauth` is enabled. The interactive consent step is built in
 * ({@link authorizeConsent}: sign-in through Better-Auth, then Allow / Deny); a subclass
 * registered via `CoreModule.forRoot(env, { ai: { mcpOAuthService } })` can restyle or replace it.
 *
 * Token format: `base64url(JSON payload).base64url(HMAC-SHA256)`.
 */
@Injectable()
export class CoreAiMcpOAuthService implements OnModuleInit {
  protected readonly logger = new Logger(CoreAiMcpOAuthService.name);

  /** Native MongoDB collections (no Mongoose schema needed for OAuth artifacts). */
  protected readonly clientsCollection = 'aiMcpOAuthClients';
  protected readonly codesCollection = 'aiMcpOAuthCodes';
  protected readonly refreshCollection = 'aiMcpOAuthRefreshTokens';

  private indexesEnsured = false;
  private warnedSecret = false;

  constructor(@InjectConnection() protected readonly connection: Connection) {}

  /**
   * Fail loud at boot when the OAuth 2.1 layer is enabled (`ai.mcp.oauth`) but no signing secret
   * is configured outside the local environments — otherwise tokens would be signed with a
   * public, insecure development default (see {@link allowsDevelopmentSecret}).
   */
  onModuleInit(): void {
    this.assertProductionSafe();
  }

  /** Throw when OAuth is enabled but no secret is configured outside local / ci / e2e. */
  assertProductionSafe(): void {
    if (this.oauthEnabled() && !this.allowsDevelopmentSecret() && !this.resolveSecret()) {
      throw new Error(
        'AI MCP OAuth signing secret is required when ai.mcp.oauth is enabled outside local / ci / e2e, ' +
          'but none is set (ai.mcp.oauthSecret / ai.encryptionSecret / NSC__AI__ENCRYPTION_SECRET / ' +
          'SECRETS_ENCRYPTION_KEY). Set a random 32+ char value.',
      );
    }
  }

  /**
   * Whether the public development key may sign tokens: only in the local environments
   * (`isLocalEnv`: `local`, `ci`, `e2e`). Deliberately not "everything except production / staging":
   * a starter-based project DEPLOYS `develop` and `test` stages, and there the public key would let
   * anybody who knows a user id forge that user's MCP access token.
   */
  protected allowsDevelopmentSecret(): boolean {
    return isLocalEnv(ConfigService.get<string>('env') ?? process.env.NODE_ENV);
  }

  /** Whether the OAuth 2.1 layer is enabled — `CoreAiMcpOAuthInitializer` mounts the endpoints only then. */
  isOAuthEnabled(): boolean {
    return this.oauthEnabled();
  }

  /**
   * Whether the built-in consent page answers `/authorize` (no subclass replaced {@link authorizeConsent}).
   * It signs users in through Better-Auth, which `CoreAiMcpOAuthInitializer` checks at boot.
   */
  usesBuiltInConsent(): boolean {
    return this.authorizeConsent === CoreAiMcpOAuthService.prototype.authorizeConsent;
  }

  /** Whether the OAuth 2.1 layer is enabled via `ai.mcp.oauth`. */
  protected oauthEnabled(): boolean {
    const mcp = ConfigService.get<{ oauth?: boolean }>('ai.mcp');
    return typeof mcp === 'object' && mcp?.oauth === true;
  }

  /** Resolve the HMAC signing secret from config/env (no dev fallback). */
  protected resolveSecret(): string | undefined {
    return (
      ConfigService.get<string>('ai.mcp.oauthSecret') ||
      ConfigService.get<string>('ai.encryptionSecret') ||
      process.env.NSC__AI__ENCRYPTION_SECRET ||
      process.env.SECRETS_ENCRYPTION_KEY
    );
  }

  // ===================================================================================================================
  // Security primitives (unit-tested)
  // ===================================================================================================================

  /**
   * Sign an access token for a user + client with a TTL (seconds).
   */
  signAccessToken(userId: string, clientId: string, ttlSeconds = 3600): string {
    const payload: AiMcpAccessTokenPayload = {
      cid: clientId,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      sub: userId,
      type: 'mcp_access',
    };
    const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${payloadStr}.${this.hmac(payloadStr)}`;
  }

  /**
   * Verify an access token's signature and expiry; returns the payload or null.
   */
  verifyAccessToken(token: string): AiMcpAccessTokenPayload | null {
    if (!token || !token.includes('.')) {
      return null;
    }
    const [payloadStr, signature] = token.split('.');
    if (!payloadStr || !signature) {
      return null;
    }
    const expected = this.hmac(payloadStr);
    if (!this.safeEqual(signature, expected)) {
      return null;
    }
    try {
      const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf8')) as AiMcpAccessTokenPayload;
      if (payload.type !== 'mcp_access' || payload.exp <= Math.floor(Date.now() / 1000)) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Verify a PKCE code verifier against a stored S256 challenge.
   */
  verifyPkce(verifier: string, challenge: string, method = 'S256'): boolean {
    if (!verifier || !challenge) {
      return false;
    }
    if (method !== 'S256') {
      // Only S256 is accepted (plain is insecure).
      return false;
    }
    const computed = createHash('sha256').update(verifier).digest('base64url');
    return this.safeEqual(computed, challenge);
  }

  /**
   * Generate a cryptographically secure random id/token.
   */
  generateId(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  // ===================================================================================================================
  // Stores (MongoDB)
  // ===================================================================================================================

  /**
   * Register a dynamic OAuth client.
   */
  async registerClient(client: AiMcpOAuthClient): Promise<AiMcpOAuthClient> {
    await this.ensureIndexes();
    await this.db()
      .collection(this.clientsCollection)
      .insertOne({ ...client, createdAt: new Date() });
    return client;
  }

  /**
   * Look up a registered client.
   *
   * Returns `client_secret` and `client_secret_expires_at` when present so the
   * SDK's `clientAuth` middleware can verify the secret on token-endpoint
   * requests (`if (client.client_secret) { …verify… }`). Public clients
   * (registered with `token_endpoint_auth_method: 'none'`) have no secret and
   * the verification branch is skipped — PKCE protects the auth-code flow.
   */
  async getClient(clientId: string): Promise<AiMcpOAuthClient | null> {
    const doc = await this.db().collection(this.clientsCollection).findOne({ client_id: clientId });
    if (!doc) {
      return null;
    }
    return {
      client_id: doc.client_id,
      client_name: doc.client_name,
      client_secret: doc.client_secret,
      client_secret_expires_at: doc.client_secret_expires_at,
      redirect_uris: doc.redirect_uris,
      token_endpoint_auth_method: doc.token_endpoint_auth_method,
    };
  }

  /**
   * Persist an authorization code with its PKCE challenge (TTL 10 minutes).
   *
   * Issuing a code IS the authorization. While answering `/authorize` this refuses unless the
   * request is a POST — the user's approval of the consent form (see `assertCodeIssuanceAllowed`).
   */
  async saveAuthorizationCode(
    code: string,
    data: { clientId: string; codeChallenge: string; userId: string },
  ): Promise<void> {
    assertCodeIssuanceAllowed();
    await this.ensureIndexes();
    await this.db().collection(this.codesCollection).insertOne({
      clientId: data.clientId,
      code,
      codeChallenge: data.codeChallenge,
      createdAt: new Date(),
      userId: data.userId,
    });
  }

  /**
   * Read an authorization code WITHOUT deleting it (for PKCE challenge lookup).
   */
  async getAuthorizationCode(
    code: string,
  ): Promise<{ clientId: string; codeChallenge: string; userId: string } | null> {
    const doc = await this.db().collection(this.codesCollection).findOne({ code });
    return doc ? { clientId: doc.clientId, codeChallenge: doc.codeChallenge, userId: doc.userId } : null;
  }

  /**
   * Consume (read + delete) an authorization code. One-time use.
   *
   * With `clientId`, only a code issued to that client is consumed — atomically, like
   * {@link rotateRefreshToken}. Another client presenting it then finds nothing and leaves the code
   * for its owner, instead of deleting it first and comparing afterwards.
   */
  async consumeAuthorizationCode(
    code: string,
    clientId?: string,
  ): Promise<{ clientId: string; codeChallenge: string; userId: string } | null> {
    const filter = clientId === undefined ? { code } : { clientId, code };
    const doc = await this.db().collection(this.codesCollection).findOneAndDelete(filter);
    const value = (doc as any)?.value ?? doc; // driver version compatibility
    if (!value) {
      return null;
    }
    return { clientId: value.clientId, codeChallenge: value.codeChallenge, userId: value.userId };
  }

  /**
   * Issue a refresh token for a user + client.
   */
  async issueRefreshToken(userId: string, clientId: string): Promise<string> {
    await this.ensureIndexes();
    const token = this.generateId();
    await this.db().collection(this.refreshCollection).insertOne({ clientId, createdAt: new Date(), token, userId });
    return token;
  }

  /**
   * Rotate a refresh token: validate, delete, issue a new one. Returns the user/client.
   *
   * The `clientId` parameter is REQUIRED — refresh tokens are bound to the
   * issuing client per OAuth 2.1 §4.13.2 / §7.4. Looking up the token alone
   * would let a different client present a stolen refresh token and obtain an
   * access token for the original user's subject (impersonation). The
   * `findOneAndDelete({ token, clientId })` query enforces the binding atomically.
   */
  async rotateRefreshToken(
    token: string,
    clientId: string,
  ): Promise<{ clientId: string; newToken: string; userId: string } | null> {
    if (!token || !clientId) {
      return null;
    }
    const doc = await this.db().collection(this.refreshCollection).findOneAndDelete({ clientId, token });
    const value = (doc as any)?.value ?? doc;
    if (!value) {
      return null;
    }
    const newToken = await this.issueRefreshToken(value.userId, value.clientId);
    return { clientId: value.clientId, newToken, userId: value.userId };
  }

  /**
   * Load the minimal user shape ({ id, roles }) for a verified OAuth subject from
   * the `users` collection (read-only). Enough for tool role-filtering + ownership.
   */
  async loadUser(userId: string): Promise<{ id: string; roles: string[] } | null> {
    try {
      const { ObjectId } = await import('mongodb');
      const query = ObjectId.isValid(userId) ? { _id: new ObjectId(userId) } : { _id: userId as any };
      const doc = await this.db()
        .collection('users')
        .findOne(query, { projection: { roles: 1 } });
      if (!doc) {
        return null;
      }
      return { id: userId, roles: Array.isArray(doc.roles) ? doc.roles : [] };
    } catch {
      return null;
    }
  }

  /**
   * Build an SDK-compatible `OAuthServerProvider` from the primitives + stores.
   *
   * The machine-to-machine methods (clients store, PKCE challenge lookup, code +
   * refresh exchange, access-token verification) are fully implemented. The
   * interactive {@link authorizeConsent} (browser login/consent) is overridable —
   * a consumer wires it to its own login + consent UI (see INTEGRATION-CHECKLIST).
   */
  buildOAuthProvider(accessTtlSeconds = 3600): Record<string, any> {
    return {
      authorize: async (client: any, params: any, res: any) => {
        // An API token (or its signed assertion) must never approve an OAuth consent. The consent mints
        // an MCP access token with the FULL rights of its user, which would lift a scope-limited user
        // token out of every restriction it carries — and a tenant token has no user to consent for at
        // all. This route is an Express router outside the Nest guards, so the deny-by-default of
        // @ApiTokenScopes() does not reach it; the check sits here rather than in authorizeConsent()
        // so an override of that method cannot drop it.
        if (getApiTokenContext(res?.req?.user)) {
          const { AccessDeniedError } = await this.loadOAuthErrors();
          throw new AccessDeniedError('An API token cannot authorize an OAuth client');
        }
        // Lets saveAuthorizationCode() refuse a code issued on GET — here, not in authorizeConsent(),
        // so an override cannot drop it.
        const method = String(res?.req?.method ?? '').toUpperCase();
        return authorizeRequest.run({ method }, () => this.authorizeConsent(client, params, res));
      },
      challengeForAuthorizationCode: async (_client: any, authorizationCode: string) => {
        const stored = await this.getAuthorizationCode(authorizationCode);
        return stored?.codeChallenge ?? '';
      },
      clientsStore: {
        getClient: (clientId: string) => this.getClient(clientId),
        registerClient: (client: AiMcpOAuthClient) => this.registerClient(client),
      },
      exchangeAuthorizationCode: async (client: any, authorizationCode: string) => {
        const stored = await this.consumeAuthorizationCode(authorizationCode, String(client?.client_id ?? ''));
        if (!stored || stored.clientId !== client?.client_id) {
          const { InvalidGrantError } = await this.loadOAuthErrors();
          throw new InvalidGrantError(
            'Authorization code is invalid, expired, already used or issued to another client',
          );
        }
        return {
          access_token: this.signAccessToken(stored.userId, stored.clientId, accessTtlSeconds),
          expires_in: accessTtlSeconds,
          refresh_token: await this.issueRefreshToken(stored.userId, stored.clientId),
          token_type: 'Bearer',
        };
      },
      exchangeRefreshToken: async (client: any, refreshToken: string) => {
        // Bind the rotating refresh token to the calling client (OAuth 2.1
        // §4.13.2 / §7.4). Without this check, a different client could present
        // a stolen refresh token and obtain an access token for the original
        // user's subject. `rotateRefreshToken` enforces the binding atomically
        // via `findOneAndDelete({ token, clientId })`.
        const callerClientId = client?.client_id;
        if (!callerClientId) {
          const { InvalidClientError } = await this.loadOAuthErrors();
          throw new InvalidClientError('Unknown client');
        }
        const rotated = await this.rotateRefreshToken(refreshToken, callerClientId);
        if (!rotated) {
          // invalid_grant is the one answer on which an MCP client discards its stored tokens and asks
          // the user to sign in again — see loadOAuthErrors().
          const { InvalidGrantError } = await this.loadOAuthErrors();
          throw new InvalidGrantError('Refresh token is invalid, already used or issued to another client');
        }
        return {
          access_token: this.signAccessToken(rotated.userId, rotated.clientId, accessTtlSeconds),
          expires_in: accessTtlSeconds,
          refresh_token: rotated.newToken,
          token_type: 'Bearer',
        };
      },
      verifyAccessToken: async (token: string) => {
        const payload = this.verifyAccessToken(token);
        if (!payload) {
          const { InvalidTokenError } = await this.loadOAuthErrors();
          throw new InvalidTokenError('Invalid or expired access token');
        }
        // `expiresAt` is part of the SDK's AuthInfo contract: its bearer middleware refuses a token without one.
        return { clientId: payload.cid, expiresAt: payload.exp, extra: { userId: payload.sub }, scopes: [], token };
      },
    };
  }

  /** Lifetime of a consent form's CSRF token, in seconds — the TTL of an authorization code. */
  protected readonly consentTokenTtlSeconds = 600;

  /**
   * The interactive authorize/consent step — built in since 11.43.0.
   *
   * - nobody signed in → the sign-in view: e-mail + password and the two-factor step against
   *   Better-Auth on this origin, then a reload of this very request; passkey / social login via the
   *   app's login page (`ai.mcp.oauthLoginUrl`, else `<appUrl>/auth/login`).
   * - signed in, GET → the consent view: which client, where the code goes, Allow / Deny, with a
   *   CSRF token bound to user, client, redirect URI and PKCE challenge.
   * - signed in, POST with Allow and a valid token → the code is issued, the browser goes to
   *   `redirect_uri?code=…&state=…`. Deny → `access_denied`. A stale token shows the form again; a
   *   foreign or tampered one too, and issues nothing.
   *
   * The signed-in user is whoever the Better-Auth middleware put on the request (session cookie or
   * bearer). An API token never gets here — `buildOAuthProvider().authorize` refuses it first — and a
   * code issued on GET is refused by `assertCodeIssuanceAllowed`.
   *
   * Override for a consent UI of your own (register the subclass via
   * `CoreModule.forRoot(env, { ai: { mcpOAuthService } })`), or override {@link renderConsentPage}
   * to only restyle this one. An own implementation must keep the same shape — a signed-in session
   * is not consent — and refuse with a class from {@link loadOAuthErrors}: any other error reaches
   * the client as `server_error`.
   */
  protected async authorizeConsent(client: any, params: any, res: any): Promise<void> {
    const req = res?.req;
    const user = await this.consentUser(req);
    const decision = req?.method === 'POST' ? req.body?.[MCP_OAUTH_CONSENT_DECISION_FIELD] : undefined;

    if (user && decision === 'deny') {
      const { AccessDeniedError } = await this.loadOAuthErrors();
      throw new AccessDeniedError('The user denied access');
    }

    let notice: IMcpOAuthConsentView['notice'];
    if (user && decision === 'approve') {
      const binding: IAiMcpOAuthConsentBinding = {
        clientId: String(client.client_id),
        codeChallenge: String(params.codeChallenge),
        redirectUri: String(params.redirectUri),
        userId: user.id,
      };
      const verdict = this.verifyConsentToken(req.body?.[MCP_OAUTH_CONSENT_TOKEN_FIELD], binding);
      if (verdict === 'valid') {
        const code = this.generateId();
        await this.saveAuthorizationCode(code, {
          clientId: binding.clientId,
          codeChallenge: binding.codeChallenge,
          userId: binding.userId,
        });
        const target = new URL(binding.redirectUri);
        target.searchParams.set('code', code);
        if (params.state) {
          target.searchParams.set('state', params.state);
        }
        res.redirect(302, target.href);
        return;
      }
      if (verdict === 'expired') {
        notice = 'expired';
      } else {
        this.logger.warn(
          `MCP OAuth consent for client ${binding.clientId} carried an invalid token (forged, tampered, or from ` +
            'another session); no code issued, the form is shown again.',
        );
      }
    }

    const view = this.buildConsentView(req, client, params, user, notice);
    res.status(200);
    for (const [name, value] of Object.entries(mcpOAuthConsentHeaders(view.nonce))) {
      res.setHeader(name, value);
    }
    res.send(this.renderConsentPage(view));
  }

  /** Renders the consent page. Override to restyle it; keep every dynamic value escaped. */
  protected renderConsentPage(view: IMcpOAuthConsentView): string {
    return renderMcpOAuthConsentPage(view);
  }

  /**
   * The user the consent is given for: whoever the Better-Auth middleware put on the request — or,
   * where it did not run, the session the request carries. Nest registers that middleware below a
   * global prefix, while the OAuth router sits at the root, so under `setGlobalPrefix()` it never
   * sees `/authorize`; the session is then resolved the way the middleware resolves it (bearer, then
   * session cookie). Never an API token — those carry their own, narrower rights.
   */
  protected async consentUser(req: any): Promise<{ email?: string; id: string; name?: string } | undefined> {
    const toConsentUser = (user: any) =>
      user?.id && !getApiTokenContext(user) ? { email: user.email, id: String(user.id), name: user.name } : undefined;
    if (req?.user?.id) {
      return toConsentUser(req.user);
    }
    const tokenService = getBetterAuthTokenService();
    if (!tokenService || !req || hasApiTokenCredential(req)) {
      return undefined;
    }
    try {
      const { token } = tokenService.extractTokenFromRequest(req);
      return token ? toConsentUser(await tokenService.verifyAndLoadUser(token)) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Builds what the page shows. */
  protected buildConsentView(
    req: any,
    client: any,
    params: any,
    user: { email?: string; id: string; name?: string } | undefined,
    notice?: IMcpOAuthConsentView['notice'],
  ): IMcpOAuthConsentView {
    const redirect = new URL(String(params.redirectUri));
    const oauthParams: Record<string, string> = {
      client_id: String(client.client_id),
      code_challenge: String(params.codeChallenge),
      code_challenge_method: 'S256',
      redirect_uri: String(params.redirectUri),
      response_type: 'code',
    };
    if (params.state) {
      oauthParams.state = String(params.state);
    }
    if (Array.isArray(params.scopes) && params.scopes.length) {
      oauthParams.scope = params.scopes.join(' ');
    }
    if (params.resource) {
      oauthParams.resource = String(params.resource.href ?? params.resource);
    }
    return {
      appHost: this.consentAppHost(),
      authBasePath: getBetterAuthTokenService()
        ? getMountedMcpOAuth()?.authBasePath || ConfigService.get<string>('betterAuth.basePath') || '/iam'
        : undefined,
      client: { id: String(client.client_id), name: client.client_name },
      csrfToken: user
        ? this.signConsentToken({
            clientId: oauthParams.client_id,
            codeChallenge: oauthParams.code_challenge,
            redirectUri: oauthParams.redirect_uri,
            userId: user.id,
          })
        : undefined,
      locale: mcpOAuthConsentLocale(req?.headers?.['accept-language']),
      loginUrl: user ? undefined : this.consentLoginUrl(req),
      nonce: randomBytes(16).toString('base64'),
      notice,
      oauthParams,
      redirect: { host: redirect.host, loopback: ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) },
      user: user ? { email: user.email, name: user.name } : undefined,
    };
  }

  /** The host users know the application by: the app's, else the server's. */
  protected consentAppHost(): string {
    for (const url of [resolveAppUrlFromConfig(ConfigService), getMountedMcpOAuth()?.baseUrl]) {
      try {
        if (url) {
          return new URL(url).host;
        }
      } catch {
        // not a URL — try the next one
      }
    }
    return '';
  }

  /**
   * The app's login page, for sign-in methods the consent page does not offer (passkey, social
   * login). `ai.mcp.oauthLoginUrl` wins; a `{returnTo}` in it is replaced by this `/authorize`
   * request's URL, for a login page that sends the user back by itself. Default:
   * `<appUrl>/auth/login`, opened next to the consent page.
   */
  protected consentLoginUrl(req: any): IMcpOAuthConsentView['loginUrl'] {
    const configured = ConfigService.get<unknown>('ai.mcp.oauthLoginUrl');
    const appUrl = resolveAppUrlFromConfig(ConfigService);
    const template =
      typeof configured === 'string' && configured.trim()
        ? configured.trim()
        : appUrl
          ? `${appUrl.replace(/\/$/, '')}/auth/login`
          : undefined;
    if (!template) {
      return undefined;
    }
    const returnsHere = template.includes('{returnTo}');
    const base = getMountedMcpOAuth()?.baseUrl;
    const returnTo = returnsHere && base && req?.originalUrl ? new URL(String(req.originalUrl), `${base}/`).href : '';
    try {
      const href = new URL(template.replace('{returnTo}', () => encodeURIComponent(returnTo))).href;
      return /^https?:/.test(href) ? { href, returnsHere } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Signs a consent form's CSRF token: `<exp>.<hmac>` over the binding and the expiry. */
  protected signConsentToken(binding: IAiMcpOAuthConsentBinding): string {
    const exp = Math.floor(Date.now() / 1000) + this.consentTokenTtlSeconds;
    return `${exp}.${this.hmac(consentTokenPayload(binding, exp))}`;
  }

  /**
   * Checks a consent form's CSRF token against the binding of THIS request. The signature is
   * checked first, so `expired` is only ever said of a token this server issued for this binding.
   */
  protected verifyConsentToken(token: unknown, binding: IAiMcpOAuthConsentBinding): 'expired' | 'invalid' | 'valid' {
    if (typeof token !== 'string') {
      return 'invalid';
    }
    const parts = token.split('.');
    const exp = Number(parts[0]);
    if (parts.length !== 2 || !Number.isSafeInteger(exp) || !parts[1]) {
      return 'invalid';
    }
    if (!this.safeEqual(parts[1], this.hmac(consentTokenPayload(binding, exp)))) {
      return 'invalid';
    }
    return exp > Math.floor(Date.now() / 1000) ? 'valid' : 'expired';
  }

  /**
   * The SDK's OAuth error classes, for every refusal the provider reports.
   *
   * The SDK's handlers decide the HTTP answer with `instanceof OAuthError`; anything else becomes
   * `500 server_error`. That is more than a wrong status: an MCP client discards its stored tokens
   * only on `invalid_grant`. A refused refresh token answered with a 500 made it keep the dead
   * token, retry the refresh, and never ask the user to sign in again.
   *
   * Imported lazily, like every other use of the SDK in this module and the same way
   * `mountAiMcpOAuth()` imports the router, so both resolve the same build of the SDK: a class
   * from its other build (CJS vs. ESM) would fail that `instanceof` just like a plain `Error`.
   */
  protected loadOAuthErrors(): Promise<typeof OAuthErrors> {
    return import('@modelcontextprotocol/sdk/server/auth/errors.js');
  }

  // ===================================================================================================================
  // Helpers
  // ===================================================================================================================

  /**
   * Compute the HMAC-SHA256 of a payload string (base64url).
   */
  protected hmac(payloadStr: string): string {
    return createHmac('sha256', this.getSecret()).update(payloadStr).digest('base64url');
  }

  /**
   * Constant-time string comparison (avoids timing attacks on token/PKCE checks).
   */
  protected safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  }

  /**
   * Resolve the HMAC secret (same sources as AiCryptoService; dedicated override
   * via `ai.mcp.oauthSecret`).
   */
  protected getSecret(): string {
    const raw = this.resolveSecret();
    if (!raw && !this.allowsDevelopmentSecret()) {
      // The boot check (assertProductionSafe) normally stops this earlier. This is the backstop for
      // a path that skipped it, e.g. a subclass whose onModuleInit() does not call super: signing
      // with the public default below would make every token forgeable.
      throw new Error(
        'AI MCP OAuth signing secret is not configured outside local / ci / e2e; refusing to sign or verify ' +
          'tokens with the public development default. Set ai.mcp.oauthSecret (or ai.encryptionSecret / ' +
          'NSC__AI__ENCRYPTION_SECRET / SECRETS_ENCRYPTION_KEY).',
      );
    }
    if (!raw) {
      if (!this.warnedSecret) {
        this.logger.warn(
          'No AI MCP OAuth secret set — using an insecure development default. Set ai.mcp.oauthSecret ' +
            '(or ai.encryptionSecret / NSC__AI__ENCRYPTION_SECRET) to a random 32+ char value in production.',
        );
        this.warnedSecret = true;
      }
      return 'lt-nest-server-ai-mcp-oauth-dev-only-insecure-default';
    }
    return raw;
  }

  /**
   * Native MongoDB database handle.
   */
  protected db() {
    if (!this.connection.db) {
      throw new Error('MongoDB connection not available for MCP OAuth');
    }
    return this.connection.db;
  }

  /**
   * Ensure TTL + unique indexes on the OAuth collections (once).
   */
  protected async ensureIndexes(): Promise<void> {
    if (this.indexesEnsured) {
      return;
    }
    this.indexesEnsured = true;
    try {
      await this.db().collection(this.clientsCollection).createIndex({ client_id: 1 }, { unique: true });
      // Authorization codes expire after 10 minutes.
      await this.db().collection(this.codesCollection).createIndex({ createdAt: 1 }, { expireAfterSeconds: 600 });
      await this.db().collection(this.codesCollection).createIndex({ code: 1 }, { unique: true });
      await this.db().collection(this.refreshCollection).createIndex({ token: 1 }, { unique: true });
    } catch (err) {
      this.logger.warn(`Could not ensure MCP OAuth indexes: ${(err as Error).message}`);
    }
  }
}
