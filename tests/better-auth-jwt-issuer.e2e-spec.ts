/**
 * Bearer JWTs under a server-level `baseUrl`.
 *
 * Better-Auth signs a JWT with `iss` / `aud` = the `baseURL` it was constructed with, and
 * `createBetterAuthInstance()` resolves that as `betterAuth.baseUrl` → the SERVER's `baseUrl` →
 * localhost default. The framework's own verifier (`CoreBetterAuthService.verifyJwksToken()`) compared
 * against `getBaseUrl()`, which knew only `betterAuth.baseUrl` and otherwise answered
 * `http://localhost:3000`. So the moment a deployment set `NSC__BASE_URL` — and `lt dev up` does, for
 * every project — without also setting `betterAuth.baseUrl`, every Bearer JWT was refused with
 * `unexpected "iss" claim value`: 401 on every request of a client in JWT mode.
 *
 * The e2e environment sets no `baseUrl`, so both sides fell back to the same localhost default and
 * every other suite stayed green. This one boots with the server `baseUrl` only.
 */
import { Controller, Get } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthModule, CoreBetterAuthService, CurrentUser, RoleEnum, Roles, TestHelper } from '../src';
import { ConfigService } from '../src/core/common/services/config.service';
import { apiTokenIamConfig, bootApiTokenIamApp, signUpAndSignIn } from './helpers/api-token-e2e.helpers';

/**
 * The shape `lt dev up` exports as `NSC__BASE_URL`, and the same URL with a trailing slash — Better-Auth
 * signs with the ORIGIN of its baseURL, so the verifier must compare against that, not the raw string.
 */
const SERVER_BASE_URLS = [
  { dbSuffix: 'jwt-issuer', serverBaseUrl: 'https://api.jwt-issuer.localhost' },
  { dbSuffix: 'jwt-issuer-slash', serverBaseUrl: 'https://api.jwt-issuer-slash.localhost/' },
];

@Controller('jwt-issuer-probe')
class JwtIssuerProbeController {
  @Get('whoami')
  @Roles(RoleEnum.S_USER)
  whoami(@CurrentUser() user: any) {
    return { id: user?.id };
  }
}

function decodePayload(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf-8'));
}

describe.each(SERVER_BASE_URLS)('Bearer JWT with only the server baseUrl $serverBaseUrl set (e2e)', ({
  dbSuffix,
  serverBaseUrl,
}) => {
  const issuer = new URL(serverBaseUrl).origin;
  let app: NestExpressApplication;
  let db: Db;
  let helper: TestHelper;
  let mongo: MongoClient;
  let previousConfig: any;

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly;
    const base = apiTokenIamConfig(dbSuffix, { baseUrl: serverBaseUrl });
    // The precondition of the defect: the server knows its URL, the betterAuth block does not.
    expect(base.betterAuth?.baseUrl).toBeUndefined();
    app = await bootApiTokenIamApp(base, { controllers: [JwtIssuerProbeController] });
    helper = new TestHelper(app);
    mongo = await MongoClient.connect(base.mongoose.uri);
    db = mongo.db();
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.close();
    CoreBetterAuthModule.reset();
    if (previousConfig) {
      ConfigService.setConfig(previousConfig, { reInit: true, warn: false });
    }
  });

  it('builds Better-Auth on the server baseUrl, and getBaseUrl() reports the origin it signs with', async () => {
    const service = app.get(CoreBetterAuthService);
    expect((service.getInstance() as any).options.baseURL).toBe(serverBaseUrl);
    expect((await (service.getInstance() as any).$context).options.baseURL).toBe(issuer);
    expect(service.getBaseUrl()).toBe(issuer);
  });

  /**
   * @regression   11.43.0 and earlier (since 11.10.3) — verifyJwksToken() checked `iss` / `aud` against
   *   getBaseUrl(), which read only `betterAuth.baseUrl` and fell back to http://localhost:3000, while
   *   Better-Auth signed with the server's baseUrl. Every Bearer JWT answered 401 under `lt dev` and in
   *   every deployment that sets NSC__BASE_URL without betterAuth.baseUrl.
   *   Under a trailing slash the review of that fix found the same 401 again: Better-Auth signs with the
   *   ORIGIN of its baseURL, and getBaseUrl() first returned the configured string.
   * @seen-failing Skip the instance baseURL in getBaseUrl() in
   *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation
   *   `jwt-issuer-ignores-server-base-url` in tests/regression-mutations.json. Returning the raw string
   *   instead of its origin turns the trailing-slash variant red — mutation `jwt-issuer-raw-base-url`.
   */
  it('accepts a JWT Better-Auth issued under the server baseUrl as Bearer token', async () => {
    const user = await signUpAndSignIn(helper, db, dbSuffix);
    expect(user.token.split('.'), 'the sign-in must yield a JWT, or this case proves nothing').toHaveLength(3);
    const payload = decodePayload(user.token);
    expect(payload.iss).toBe(issuer);
    expect(payload.aud).toBe(issuer);

    const response = await helper.rest('/jwt-issuer-probe/whoami', { statusCode: 200, token: user.token });
    expect(response.id).toBe(user.id);
  });

  /**
   * The paired refusal: the verifier must still CHECK the issuer — a fix that dropped the claim check
   * would make the case above pass too. Two tokens signed with one registered key, identical except
   * for `iss` / `aud`: only the one naming this server may authenticate, so the issuer check is what
   * refuses the other — not the key, the signature or the user.
   */
  it('refuses a JWT signed with a registered key that names another issuer', async () => {
    const user = await signUpAndSignIn(helper, db, `${dbSuffix}-foreign`);
    const claims = decodePayload(user.token);
    const kid = `jwt-issuer-spec-${Date.now()}`;
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
    // Dated in the past, so Better-Auth never picks this key to sign with; its private half is never used.
    await db.collection('jwks').insertOne({
      createdAt: new Date(0),
      id: kid,
      privateKey: 'unused-by-this-spec',
      publicKey: JSON.stringify(await exportJWK(publicKey)),
    });
    const sign = (iss: string) =>
      new SignJWT({ ...claims, aud: iss, iss }).setProtectedHeader({ alg: 'EdDSA', kid }).sign(privateKey);

    try {
      const own = await helper.rest('/jwt-issuer-probe/whoami', {
        statusCode: 200,
        token: await sign(issuer),
      });
      expect(own.id).toBe(user.id);

      await helper.rest('/jwt-issuer-probe/whoami', { statusCode: 401, token: await sign('http://localhost:3000') });
    } finally {
      await db.collection('jwks').deleteOne({ id: kid });
    }
  });
});
