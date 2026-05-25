import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Connection } from 'mongoose';

import { isProductionLikeEnv } from '../../../common/helpers/cookies.helper';
import { ConfigService } from '../../../common/services/config.service';

/**
 * Stored OAuth client (dynamically registered).
 */
export interface AiMcpOAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
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
 * Security core for the MCP OAuth 2.1 flow.
 *
 * Implements the security-critical primitives — HMAC-signed access tokens
 * (constant-time verification), PKCE (S256) verification — and MongoDB-backed
 * stores for dynamically registered clients, authorization codes (TTL) and
 * refresh tokens. These power the SDK `OAuthServerProvider` returned by
 * {@link buildOAuthProvider}, which `mcpAuthRouter` mounts (see
 * `mountAiMcpOAuth`). The interactive consent/authorize flow is a thin layer on
 * top of these primitives and is documented in the integration checklist.
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
   * Fail loud at boot in production/staging when the OAuth 2.1 layer is enabled
   * (`ai.mcp.oauth`) but no signing secret is configured — otherwise tokens would be
   * signed with a public, insecure development default.
   */
  onModuleInit(): void {
    this.assertProductionSafe();
  }

  /** Throw in production/staging when OAuth is enabled but no secret is configured. */
  assertProductionSafe(): void {
    if (this.oauthEnabled() && isProductionLikeEnv(ConfigService.get<string>('env')) && !this.resolveSecret()) {
      throw new Error(
        'AI MCP OAuth signing secret is required in production/staging when ai.mcp.oauth is enabled, ' +
          'but none is set (ai.mcp.oauthSecret / ai.encryptionSecret / NSC__AI__ENCRYPTION_SECRET / ' +
          'SECRETS_ENCRYPTION_KEY). Set a random 32+ char value.',
      );
    }
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
   */
  async getClient(clientId: string): Promise<AiMcpOAuthClient | null> {
    const doc = await this.db().collection(this.clientsCollection).findOne({ client_id: clientId });
    return doc ? { client_id: doc.client_id, client_name: doc.client_name, redirect_uris: doc.redirect_uris } : null;
  }

  /**
   * Persist an authorization code with its PKCE challenge (TTL 10 minutes).
   */
  async saveAuthorizationCode(
    code: string,
    data: { clientId: string; codeChallenge: string; userId: string },
  ): Promise<void> {
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
   */
  async consumeAuthorizationCode(
    code: string,
  ): Promise<{ clientId: string; codeChallenge: string; userId: string } | null> {
    const doc = await this.db().collection(this.codesCollection).findOneAndDelete({ code });
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
   */
  async rotateRefreshToken(token: string): Promise<{ clientId: string; newToken: string; userId: string } | null> {
    const doc = await this.db().collection(this.refreshCollection).findOneAndDelete({ token });
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
      authorize: (client: any, params: any, res: any) => this.authorizeConsent(client, params, res),
      challengeForAuthorizationCode: async (_client: any, authorizationCode: string) => {
        const stored = await this.getAuthorizationCode(authorizationCode);
        return stored?.codeChallenge ?? '';
      },
      clientsStore: {
        getClient: (clientId: string) => this.getClient(clientId),
        registerClient: (client: AiMcpOAuthClient) => this.registerClient(client),
      },
      exchangeAuthorizationCode: async (client: any, authorizationCode: string) => {
        const stored = await this.consumeAuthorizationCode(authorizationCode);
        if (!stored || stored.clientId !== client.client_id) {
          throw new Error('invalid_grant');
        }
        return {
          access_token: this.signAccessToken(stored.userId, stored.clientId, accessTtlSeconds),
          expires_in: accessTtlSeconds,
          refresh_token: await this.issueRefreshToken(stored.userId, stored.clientId),
          token_type: 'Bearer',
        };
      },
      exchangeRefreshToken: async (_client: any, refreshToken: string) => {
        const rotated = await this.rotateRefreshToken(refreshToken);
        if (!rotated) {
          throw new Error('invalid_grant');
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
          throw new Error('invalid_token');
        }
        return { clientId: payload.cid, extra: { userId: payload.sub }, scopes: [], token };
      },
    };
  }

  /**
   * Interactive authorize/consent step. Override to integrate your login + consent
   * UI: authenticate the user, then call {@link saveAuthorizationCode} and redirect
   * to `redirect_uri?code=...&state=...`. Default: not implemented.
   */
  protected async authorizeConsent(_client: any, _params: any, _res: any): Promise<void> {
    throw new Error(
      'authorizeConsent is not implemented — override CoreAiMcpOAuthService.authorizeConsent to wire your login/consent UI.',
    );
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
