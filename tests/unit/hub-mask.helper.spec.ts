import { describe, expect, it } from 'vitest';

import { maskConfigDeep } from '../../src/core/modules/hub/helpers/hub-mask.helper';

describe('maskConfigDeep', () => {
  it('masks values whose key matches the secret pattern', () => {
    const out = maskConfigDeep({
      jwt: { secret: 'SENTINEL_JWT', refresh: { secret: 'SENTINEL_REFRESH' } },
      port: 3000,
    });

    expect(out.jwt.secret).toBe('***');
    expect(out.jwt.refresh.secret).toBe('***');
    expect(out.port).toBe(3000);
  });

  it('masks a broad set of secret-ish key names', () => {
    const out = maskConfigDeep({
      apiKey: 'AK',
      betterAuth: { secret: 'BA' },
      encryptionSecret: 'ENC',
      password: 'PW',
      privateKey: 'PK',
      token: 'TK',
    });

    for (const value of Object.values(out)) {
      const flat = JSON.stringify(value);
      expect(flat).not.toMatch(/AK|BA|ENC|PW|PK|TK/);
    }
  });

  it('deep-clones — the input object is never mutated', () => {
    const input = { jwt: { secret: 'SENTINEL' }, nested: { arr: [{ token: 'T' }] } };
    const out = maskConfigDeep(input);

    expect(input.jwt.secret).toBe('SENTINEL');
    expect(input.nested.arr[0].token).toBe('T');
    expect(out.jwt.secret).toBe('***');
    expect(out.nested.arr[0].token).toBe('***');
  });

  it('masks credentials embedded in URI-shaped values', () => {
    const out = maskConfigDeep({ mongoose: { uri: 'mongodb://user:secretpw@host:27017/db' } });

    expect(out.mongoose.uri).not.toContain('secretpw');
    expect(out.mongoose.uri).toContain('mongodb://');
    expect(out.mongoose.uri).toContain('host:27017');
  });

  // Regression: the userinfo USER part used to be `+` (at least one character), so the
  // password-only form fell straight through and printed verbatim in the Hub config panel.
  // That is the canonical Redis URL — Redis < 6 has no username, and `redis-cli -u`,
  // Heroku Redis and ElastiCache AUTH all emit it — and `redis.url` only became a config
  // option in 11.33.0, which is why no existing example covered it.
  it.each([
    'redis://:s3cr3t@redis.internal:6379',
    'rediss://:s3cr3t@redis.internal:6380/0',
    'amqp://:s3cr3t@broker:5672',
  ])('masks a password-only connection URI (%s)', (url) => {
    const out = maskConfigDeep({ redis: { url } });

    expect(out.redis.url).not.toContain('s3cr3t');
    expect(out.redis.url).toContain('@');
  });

  it('does not mistake a path segment containing @ for credentials', () => {
    const out = maskConfigDeep({ service: { endpoint: 'http://host:8080/path@version' } });

    // The password group cannot span a `/`, so this must pass through untouched.
    expect(out.service.endpoint).toBe('http://host:8080/path@version');
  });

  it('masks an S3 access key id, not only the secret access key', () => {
    const out = maskConfigDeep({ s3: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'shhh' } });

    // `(^|[^a-z])key([^a-z]|$)` cannot catch `accessKeyId`: the `i` flag makes `[^a-z]`
    // reject the uppercase `K`/`I`, so `…sKeyI…` fails it. `secretAccessKey` was already
    // covered by `secret`; the ID was the one that rendered in the panel.
    expect(out.s3.accessKeyId).not.toContain('AKIAEXAMPLE');
    expect(out.s3.secretAccessKey).not.toContain('shhh');
  });

  it('honors additional explicit secret field names', () => {
    const out = maskConfigDeep({ customField: 'HIDE_ME', other: 'keep' }, ['customField']);

    expect(out.customField).toBe('***');
    expect(out.other).toBe('keep');
  });

  it('passes through null, numbers, booleans and dates', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const out = maskConfigDeep({ a: null, b: 42, c: true, d: date });

    expect(out.a).toBeNull();
    expect(out.b).toBe(42);
    expect(out.c).toBe(true);
    expect(out.d).toBeInstanceOf(Date);
  });
});
