import { describe, expect, it } from 'vitest';

import { maskConfigDeep } from './hub-mask.helper';

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
