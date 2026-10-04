import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';

import { CoreAuthService } from '../../src/core/modules/auth/services/core-auth.service';

/**
 * `CoreAuthService.verifyJwt()` — the legacy access-token check for transports without passport.
 *
 * The HTTP path verifies a legacy JWT through passport-jwt: signature and expiry, with
 * `jwt.secretOrPrivateKey || jwt.secret` or a configured `jwt.secretOrKeyProvider`. The GraphQL
 * WebSocket handshake had no passport in front of it and used `decodeJwt()`, which reads a payload
 * without checking either. These cases pin that `verifyJwt()` accepts exactly what passport accepts.
 */
describe('CoreAuthService.verifyJwt', () => {
  const SECRET = 'legacy-unit-secret-0123456789abcdef';
  const PAYLOAD = { deviceId: 'device-1', id: 'user-1', tokenId: 'token-1' };
  const signer = new JwtService();

  /** A ConfigService stand-in that answers `getFastButReadOnly('jwt.…')` from `jwt`. */
  const serviceWith = (jwt: Record<string, any>) => {
    const configService = {
      getFastButReadOnly: (path: string, fallback?: unknown) => {
        const value = path.split('.').reduce<any>((node, key) => node?.[key], { jwt });
        return value === undefined ? fallback : value;
      },
    };
    return new CoreAuthService({} as any, new JwtService(), configService as any);
  };

  it('answers the payload of a token signed with jwt.secret', async () => {
    const token = signer.sign(PAYLOAD, { expiresIn: '5m', secret: SECRET });
    expect(await serviceWith({ secret: SECRET }).verifyJwt(token)).toMatchObject(PAYLOAD);
  });

  it('refuses a token signed with another key', async () => {
    const token = signer.sign(PAYLOAD, { expiresIn: '5m', secret: 'somebody-elses-secret-0123456789' });
    expect(await serviceWith({ secret: SECRET }).verifyJwt(token)).toBeNull();
  });

  /**
   * @regression   11.42.3 — the legacy WebSocket handshake accepted an expired access token, because it
   *   only decoded it; this is the check that replaced the decode.
   * @seen-failing Pass `ignoreExpiration: true` to `verifyAsync()` in `verifyJwt()` in
   *   src/core/modules/auth/services/core-auth.service.ts — registered as mutation
   *   `legacy-verify-jwt-ignores-expiry` in tests/regression-mutations.json.
   */
  it('refuses an expired token', async () => {
    const token = signer.sign({ ...PAYLOAD, exp: Math.floor(Date.now() / 1000) - 60 }, { secret: SECRET });
    expect(await serviceWith({ secret: SECRET }).verifyJwt(token)).toBeNull();
  });

  it('refuses a token whose payload was altered after signing', async () => {
    const [header, , signature] = signer.sign(PAYLOAD, { expiresIn: '5m', secret: SECRET }).split('.');
    const altered = Buffer.from(JSON.stringify({ ...PAYLOAD, id: 'user-2' })).toString('base64url');
    expect(await serviceWith({ secret: SECRET }).verifyJwt(`${header}.${altered}.${signature}`)).toBeNull();
  });

  it('refuses an unsigned token (alg: none)', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(PAYLOAD)).toString('base64url');
    expect(await serviceWith({ secret: SECRET }).verifyJwt(`${header}.${body}.`)).toBeNull();
  });

  it('refuses what is not a JWT at all, and an empty value', async () => {
    const service = serviceWith({ secret: SECRET });
    expect(await service.verifyJwt('not-a-jwt')).toBeNull();
    expect(await service.verifyJwt('')).toBeNull();
    expect(await service.verifyJwt(undefined as any)).toBeNull();
  });

  it('uses jwt.secretOrPrivateKey before jwt.secret — the order passport-jwt applies', async () => {
    const token = signer.sign(PAYLOAD, { expiresIn: '5m', secret: SECRET });
    expect(await serviceWith({ secret: 'other', secretOrPrivateKey: SECRET }).verifyJwt(token)).toMatchObject(PAYLOAD);
    expect(await serviceWith({ secret: SECRET, secretOrPrivateKey: 'other' }).verifyJwt(token)).toBeNull();
  });

  it('asks jwt.secretOrKeyProvider when one is configured', async () => {
    const token = signer.sign(PAYLOAD, { expiresIn: '5m', secret: SECRET });
    const provider = (_request: unknown, rawJwtToken: string, done: (err: any, secret: string) => void) => {
      expect(rawJwtToken).toBe(token);
      done(null, SECRET);
    };
    expect(await serviceWith({ secret: 'ignored', secretOrKeyProvider: provider }).verifyJwt(token)).toMatchObject(
      PAYLOAD,
    );
  });

  it('refuses when no verification key is configured at all', async () => {
    const token = signer.sign(PAYLOAD, { expiresIn: '5m', secret: SECRET });
    expect(await serviceWith({}).verifyJwt(token)).toBeNull();
  });
});
