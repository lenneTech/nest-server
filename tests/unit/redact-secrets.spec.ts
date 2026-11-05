import { NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configEndpointResponse, isConfigEndpointEnabled } from '../../src/core/common/helpers/config-endpoint.helper';
import { REDACTED_VALUE, redactSecrets } from '../../src/core/common/helpers/redact-secrets.helper';
import { ConfigService } from '../../src/core/common/services/config.service';
import { maskConfigDeep } from '../../src/core/modules/hub/helpers/hub-mask.helper';

/**
 * `GET /config` returned the whole configuration to every administrator until 12.5.0: database URI, auth secrets,
 * mail password. A project created before the starter redacted kept doing so. Since 12.5.0 the core redacts
 * (`redactSecrets()`, the masker the Hub config panel already used) and the endpoint is closed outside the local
 * environments (`configEndpoint`). The HTTP side is proven by tests/config-endpoint.e2e-spec.ts and
 * tests/server.e2e-spec.ts.
 */

/** Every secret a deployment's configuration typically holds, each with a value that must never appear */
const SECRETS = {
  ai: { defaultConnection: { apiKey: 'SECRET-ai-api-key' }, encryptionSecret: 'SECRET-ai-encryption' },
  apiTokens: { encryptionKey: 'SECRET-api-token-key' },
  betterAuth: {
    secret: 'SECRET-better-auth',
    socialProviders: { google: { clientId: 'public-client-id', clientSecret: 'SECRET-google-client' } },
  },
  brevo: { apiKey: 'SECRET-brevo' },
  database: {
    ownerUrl: 'postgres://owner:SECRET-pg-owner@db.internal:5432/app',
    url: 'postgres://app@db.internal:5432/app?sslmode=require&password=SECRET-pg-query',
  },
  email: {
    mailjet: { api_key_private: 'SECRET-mailjet-private', api_key_public: 'SECRET-mailjet-public' },
    smtp: { auth: { pass: 'SECRET-smtp-pass', user: 'mailer@test.com' }, host: 'smtp.test.com' },
  },
  jwt: { refresh: { secret: 'SECRET-jwt-refresh' }, secret: 'SECRET-jwt' },
  mongoose: { uri: 'mongodb://admin:SECRET-mongo@mongo.internal:27017/app?authSource=admin' },
  redis: { url: 'redis://:SECRET-redis@redis.internal:6379' },
  s3: { accessKeyId: 'SECRET-s3-access-id', secretAccessKey: 'SECRET-s3-secret' },
  sentry: { dsn: 'https://SECRET-sentry-key@sentry.io/1' },
  sync: { cursorSecret: 'SECRET-sync-cursor' },
  systemSetup: { httpInit: { token: 'SECRET-setup-token' }, initialAdmin: { password: 'SECRET-initial-admin' } },
};

describe('redactSecrets()', () => {
  it('leaves no secret of a typical deployment configuration in the output', () => {
    const out = JSON.stringify(redactSecrets(SECRETS));
    expect(out).not.toContain('SECRET-');
    // What is not secret stays readable
    expect(out).toContain('public-client-id');
    expect(out).toContain('smtp.test.com');
    expect(out).toContain('db.internal:5432');
    expect(out).toContain('authSource=admin');
  });

  /**
   * @regression   12.5.0 — a secret-named key holding an OBJECT must not be a way around the mask.
   * @seen-failing Stop passing `underSecretKey` on to the children in redactValue() in
   *   src/core/common/helpers/redact-secrets.helper.ts — registered as mutation
   *   `redact-secrets-nested-under-secret-key` in tests/regression-mutations.json.
   */
  it('masks everything below a secret-named key, except booleans', () => {
    const out = redactSecrets({
      credentials: { enabled: true, nested: { user: 'SECRET-user', values: ['SECRET-a', 42] } },
      emailAndPassword: { disableSignUp: true, minPasswordLength: 8 },
    });
    expect(JSON.stringify(out)).not.toContain('SECRET-');
    expect(out.credentials.enabled).toBe(true);
    expect(out.credentials.nested.values).toEqual([REDACTED_VALUE, REDACTED_VALUE]);
    expect(out.emailAndPassword.disableSignUp).toBe(true);
    expect(out.emailAndPassword.minPasswordLength).toBe(REDACTED_VALUE);
  });

  /**
   * @regression   12.5.0 — a PostgreSQL or MongoDB URL can carry its password as a query parameter.
   * @seen-failing Return the URI unchanged after the user-info replacement in redactString() in
   *   src/core/common/helpers/redact-secrets.helper.ts — registered as mutation
   *   `redact-secrets-uri-query-param` in tests/regression-mutations.json.
   */
  it('masks secret-named query parameters of a URI, whatever its key is called', () => {
    const out = redactSecrets({
      endpoint: 'https://api.test.com/v1?token=SECRET-1&page=2&api_key=SECRET-2&sslpassword=SECRET-3',
    });
    expect(out.endpoint).not.toContain('SECRET-');
    expect(out.endpoint).toContain('page=2');
    expect(out.endpoint).toContain(`token=${REDACTED_VALUE}`);
  });

  it('masks the password of a connection URI and keeps the rest', () => {
    const out = redactSecrets({ link: 'mongodb://user:SECRET-pw@host:27017/db' });
    expect(out.link).toBe(`mongodb://user:${REDACTED_VALUE}@host:27017/db`);
  });

  it('honours additional secret field names', () => {
    const out = redactSecrets({ customField: 'SECRET-custom', other: 'keep' }, ['customField']);
    expect(out).toEqual({ customField: REDACTED_VALUE, other: 'keep' });
  });

  it('never mutates its input and keeps the Hub name working', () => {
    const input = { jwt: { secret: 'SECRET-x' } };
    const out = maskConfigDeep(input);
    expect(input.jwt.secret).toBe('SECRET-x');
    expect(out.jwt.secret).toBe(REDACTED_VALUE);
  });

  it('passes plain strings, numbers, dates and empty values through', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const out = redactSecrets({ a: null, b: 42, c: 'plain text with token=x', d: date, e: undefined });
    expect(out).toEqual({ a: null, b: 42, c: 'plain text with token=x', d: date, e: undefined });
  });
});

describe('isConfigEndpointEnabled()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * @regression   12.5.0 — `GET /config` answered in every environment; it is now closed outside the local ones
   *   unless `configEndpoint` opens it.
   * @seen-failing Return true for an unset `configEndpoint` in isConfigEndpointEnabled() in
   *   src/core/common/helpers/config-endpoint.helper.ts — registered as mutation
   *   `config-endpoint-open-by-default` in tests/regression-mutations.json.
   */
  it.each(['develop', 'test', 'staging', 'production', 'qa', ''])('is closed by default in %j', (env) => {
    expect(isConfigEndpointEnabled({ env })).toBe(false);
  });

  it.each(['local', 'ci', 'e2e'])('is open by default in %j', (env) => {
    expect(isConfigEndpointEnabled({ env })).toBe(true);
  });

  it('follows an explicit boolean in every environment', () => {
    expect(isConfigEndpointEnabled({ configEndpoint: true, env: 'production' })).toBe(true);
    expect(isConfigEndpointEnabled({ configEndpoint: false, env: 'local' })).toBe(false);
  });

  it('reads a non-boolean value as "not set"', () => {
    expect(isConfigEndpointEnabled({ configEndpoint: 'true' as any, env: 'production' })).toBe(false);
    expect(isConfigEndpointEnabled({ configEndpoint: 'false' as any, env: 'local' })).toBe(true);
  });

  it('falls back to NODE_ENV when the configuration names no environment', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(isConfigEndpointEnabled({})).toBe(false);
    vi.stubEnv('NODE_ENV', 'e2e');
    expect(isConfigEndpointEnabled({})).toBe(true);
  });
});

describe('configEndpointResponse() and ConfigService.getRedactedConfig()', () => {
  it('answers the redacted configuration where the endpoint is open', () => {
    ConfigService.setConfig({ ...SECRETS, env: 'e2e', security: { secretFields: ['customSecret'] } } as any, {
      reInit: true,
    });
    ConfigService.mergeConfig({ customSecret: 'SECRET-project-field' } as any);

    const body = configEndpointResponse();
    expect(JSON.stringify(body)).not.toContain('SECRET-');
    expect(body.env).toBe('e2e');
    expect(JSON.stringify(ConfigService.getRedactedConfig())).not.toContain('SECRET-');
    // The live configuration is untouched
    expect(ConfigService.configFastButReadOnly.jwt.secret).toBe('SECRET-jwt');
  });

  it('answers 404 where the endpoint is closed', () => {
    ConfigService.setConfig({ ...SECRETS, env: 'production' } as any, { reInit: true });
    expect(() => configEndpointResponse()).toThrow(NotFoundException);
  });

  it('redacts the configuration the ConfigService prints on request', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    ConfigService.setConfig({ env: 'unit' } as any, { reInit: true });
    ConfigService.mergeConfig({ jwt: { secret: 'SECRET-printed' } } as any, { warn: true });
    ConfigService.setConfig({ env: 'unit', jwt: { secret: 'SECRET-reinit' } } as any, { reInit: true, warn: true });

    const printed = warn.mock.calls.flat().join('\n');
    expect(printed).toContain('ConfigService merged');
    expect(printed).toContain('ConfigService reinitialized');
    expect(printed).not.toContain('SECRET-');
  });
});
