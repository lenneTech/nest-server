import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Schema as MongooseSchema } from 'mongoose';
import { afterEach, describe, expect, it } from 'vitest';

import { computedDefault } from '../../src/core/common/persistence/mongo/declared-schema.view';
import { DeclaredSchema } from '../../src/core/common/persistence/mongo/model-declarations';
import { registerDataStore } from '../../src/core/common/persistence/persistence-runtime.registry';
import { AI_INTERACTION_MODEL, AI_MCP_OAUTH_CLIENT_MODEL } from '../../src/core/modules/ai/core-ai.constants';
import { CoreAiBudgetService } from '../../src/core/modules/ai/services/core-ai-budget.service';
import { CoreAiConversationService } from '../../src/core/modules/ai/services/core-ai-conversation.service';
import { CoreAiMcpOAuthService } from '../../src/core/modules/ai/services/core-ai-mcp-oauth.service';
import { CoreBetterAuthChallengeService } from '../../src/core/modules/better-auth/core-better-auth-challenge.service';
import { setBetterAuthSqlStore } from '../../src/core/modules/better-auth/core-better-auth-sql.registry';
import { CoreBetterAuthService } from '../../src/core/modules/better-auth/core-better-auth.service';

/**
 * A project on PostgreSQL alone (12.1.0+) connects no MongoDB: `@InjectConnection()` receives `null`. Every service that
 * found its SQL store through the connection's Mongoose models must find it without one — through the store registered
 * for the model, or Better-Auth's SQL store. The e2e suites never reach this: their configuration keeps `mongoose`, so a
 * connection always exists.
 */
const sqlStore = (name: string, methods: Record<string, unknown>) =>
  ({ capabilities: { mongoosePopulate: false }, driver: 'postgres', modelName: name, ...methods }) as any;

/** A service as Nest would build it, with the `null` connection `NoMongoConnectionModule` provides */
function withoutConnection<T>(type: abstract new (...args: any[]) => T): T {
  const service = Object.create(type.prototype);
  Object.defineProperty(service, 'connection', { value: null });
  return service;
}

describe('SQL paths without a MongoDB connection', () => {
  afterEach(() => {
    setBetterAuthSqlStore(undefined);
    for (const name of [AI_INTERACTION_MODEL, AI_MCP_OAUTH_CLIENT_MODEL, 'User']) {
      registerDataStore(name, undefined as any);
    }
  });

  /**
   * @regression   DEV-3833 (db-agnostic phase 5) — verifyJwtToken() reached the JWKS only with a MongoDB connection,
   *   although the keys live in the SQL source with the users; every Better-Auth JWT answered 401 on PostgreSQL alone.
   * @seen-failing Require the connection again before verifyJwksToken() in
   *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation `jwks-verify-needs-connection`
   *   in tests/regression-mutations.json.
   */
  it('verifies a Better-Auth JWT against the JWKS on the SQL source', async () => {
    const baseUrl = 'http://localhost:3000';
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const kid = 'kid-without-connection';
    setBetterAuthSqlStore({
      findJwk: async (id: string) =>
        id === kid ? { alg: 'EdDSA', id: kid, publicKey: JSON.stringify(await exportJWK(publicKey)) } : null,
    } as any);
    const jwt = await new SignJWT({ email: 'jwt@without-mongodb.test' })
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setSubject('64b7f0c2a1b2c3d4e5f60718')
      .setIssuer(baseUrl)
      .setAudience(baseUrl)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const service = new CoreBetterAuthService(
      { options: { baseURL: baseUrl } } as any,
      null as any,
      {
        baseUrl,
        jwt: true,
      } as any,
    );
    expect(await service.verifyJwtToken(jwt)).toMatchObject({ sub: '64b7f0c2a1b2c3d4e5f60718' });
  });

  /**
   * @regression   DEV-3833 (db-agnostic phase 5) — the challenge service switched itself off without a MongoDB
   *   connection, so the passkey challenge mapping a cookieless (JWT-mode) client needs was gone on PostgreSQL alone.
   * @seen-failing Switch the service off again when there is no connection in
   *   src/core/modules/better-auth/core-better-auth-challenge.service.ts — registered as mutation
   *   `passkey-challenge-needs-connection` in tests/regression-mutations.json.
   */
  it('keeps the passkey challenge mapping on the SQL source', async () => {
    const service = new CoreBetterAuthChallengeService(null as any, { get: () => ({ passkey: true }) } as any);
    await service.onModuleInit();
    setBetterAuthSqlStore({} as any);
    expect(service.isEnabled()).toBe(true);
  });

  /**
   * @regression   DEV-3833 (db-agnostic phase 5) — the AI budget, the MCP OAuth stores and the conversation attribution
   *   found their SQL store only through `connection.models`; without a connection the AI usage and every MCP OAuth step
   *   answered 500 ("Cannot read properties of null").
   * @seen-failing Answer `undefined` instead of the registered store in getModelStore()
   *   (src/core/common/persistence/persistence-runtime.registry.ts) — registered as mutation
   *   `model-store-needs-connection` in tests/regression-mutations.json.
   */
  it('reaches the AI and MCP OAuth stores through the registered store of the model', async () => {
    registerDataStore(
      AI_INTERACTION_MODEL,
      sqlStore(AI_INTERACTION_MODEL, { sum: async () => ({ count: 2, sum: 42 }) }),
    );
    const usage = await withoutConnection(CoreAiBudgetService).getUsage({ userId: 'u1' }, 'day');
    expect(usage).toMatchObject({ usedPrompts: 2, usedTokens: 42 });

    registerDataStore(
      AI_MCP_OAUTH_CLIENT_MODEL,
      sqlStore(AI_MCP_OAUTH_CLIENT_MODEL, {
        findOne: async () => ({ client: { client_id: 'c1', redirect_uris: ['https://app.test/cb'] } }),
      }),
    );
    expect(await withoutConnection(CoreAiMcpOAuthService).getClient('c1')).toMatchObject({ client_id: 'c1' });

    registerDataStore(
      'User',
      sqlStore('User', { find: async () => [{ email: 'owner@test.test', id: 'a'.repeat(24) }] }),
    );
    const conversations: any[] = [{ createdBy: 'a'.repeat(24) }];
    await withoutConnection(CoreAiConversationService)['attachCreators'](conversations);
    expect(conversations[0].createdByUser).toMatchObject({ email: 'owner@test.test' });
  });

  /**
   * @regression   DEV-3833 (db-agnostic phase 5) — without Mongoose a model's schema is a declared one, which has no
   *   `path().getDefault()`: every insert of a model with a computed default (`default: Date.now`, `{}` on a Mixed
   *   field) failed with "schema.path is not a function".
   * @seen-failing Answer `undefined` for a declared schema's function default in computedDefault()
   *   (src/core/common/persistence/mongo/declared-schema.view.ts) — registered as mutation
   *   `declared-default-not-computed` in tests/regression-mutations.json.
   */
  it('computes a declared schema default as Mongoose does', () => {
    const definition = {
      label: {
        default(this: { title?: string }) {
          return `${this.title}!`;
        },
        type: String,
      },
      meta: { default: {}, type: Object },
      stampedAt: { default: Date.now, type: Date },
      title: String,
    };
    const declared = new DeclaredSchema({ definition });
    const mongoose = new MongooseSchema(definition);
    const doc = { title: 'note' };

    expect(computedDefault(declared, 'label', doc)).toBe(computedDefault(mongoose, 'label', doc));
    const meta = computedDefault(declared, 'meta', doc);
    expect(meta).toEqual(computedDefault(mongoose, 'meta', doc));
    // A fresh object per document, as Mongoose's Mixed makes of `{}`
    expect(meta).not.toBe(computedDefault(declared, 'meta', doc));
    // Not cast: the store casts the number for its column, as Mongoose casts it for the document
    const before = Date.now();
    const stamped = computedDefault(declared, 'stampedAt', doc) as number;
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(Math.abs(stamped - (computedDefault(mongoose, 'stampedAt', doc) as Date).getTime())).toBeLessThan(1000);
  });
});
