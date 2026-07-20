import { describe, expect, it } from 'vitest';

import { redactSensitiveText } from './logging.helper';

describe('redactSensitiveText', () => {
  it('redacts JWTs appearing anywhere in a line', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = redactSensitiveText(`token issued: ${jwt} done`);

    expect(out).not.toContain(jwt);
    expect(out).toContain('token issued:');
    expect(out).toContain('done');
  });

  it('redacts Authorization Bearer values', () => {
    const out = redactSensitiveText('Authorization: Bearer abcdef1234567890secret');

    expect(out).not.toContain('abcdef1234567890secret');
    expect(out.toLowerCase()).toContain('authorization');
  });

  it('redacts key/value secrets regardless of separator or quoting', () => {
    expect(redactSensitiveText('password=SuperSecret123')).not.toContain('SuperSecret123');
    expect(redactSensitiveText('token: "abcd1234efgh"')).not.toContain('abcd1234efgh');
    expect(redactSensitiveText("apiKey='pk_live_9999'")).not.toContain('pk_live_9999');
    expect(redactSensitiveText('client_secret=verySecretValue')).not.toContain('verySecretValue');
  });

  it('redacts cookie headers', () => {
    const out = redactSensitiveText('cookie: session=abc123; other=xyz789');

    expect(out).not.toContain('abc123');
    expect(out).not.toContain('xyz789');
  });

  it('redacts reset/verification tokens carried as a URL PATH segment (not key=value)', () => {
    const link = 'https://app.example.com/verify/AbCdEf0123456789XyZtoken please click';
    const out = redactSensitiveText(link);
    expect(out).not.toContain('AbCdEf0123456789XyZtoken');
    expect(out).toContain('/verify/');
    // also for reset / set-password style links
    expect(redactSensitiveText('/reset/SUPERSECRETVALUE1234567890')).not.toContain('SUPERSECRETVALUE1234567890');
    expect(redactSensitiveText('/set-password/ZZZ1112223334445556667')).not.toContain('ZZZ1112223334445556667');
  });

  it('leaves harmless short path segments untouched', () => {
    // Only long token-like segments (>= 16 chars) are masked — normal routes stay readable.
    const text = 'GET /verify/email done';
    expect(redactSensitiveText(text)).toBe(text);
  });

  it('leaves harmless text untouched', () => {
    const text = 'User signed in successfully with id 507f1f77bcf86cd799439011';
    expect(redactSensitiveText(text)).toBe(text);
  });

  it('handles empty / non-secret input without throwing', () => {
    expect(redactSensitiveText('')).toBe('');
    expect(redactSensitiveText('plain message')).toBe('plain message');
  });
});
