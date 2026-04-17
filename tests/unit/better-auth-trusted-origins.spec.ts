/**
 * Unit Tests: buildTrustedOrigins — Server-level CORS propagation to BetterAuth
 *
 * Verifies that the `serverCorsConfig` parameter added in v11.25.0 correctly
 * propagates to BetterAuth's trustedOrigins, keeping the three CORS layers
 * (GraphQL, REST, BetterAuth) in sync.
 */

import { describe, expect, it } from 'vitest';

import { buildTrustedOrigins } from '../../src/core/modules/better-auth/better-auth.config';

// Helper to construct the options shape expected by buildTrustedOrigins
const opts = (args: {
  passkeyEnabled?: boolean;
  passkeyTrustedOrigins?: string[];
  resolvedAppUrl?: string;
  resolvedBaseUrl?: string;
  serverCorsConfig?: any;
}) => ({
  passkeyNormalization: {
    enabled: args.passkeyEnabled ?? false,
    normalizedConfig: null,
    trustedOrigins: args.passkeyTrustedOrigins ?? null,
    warnings: [],
  } as any,
  resolvedUrls: {
    appUrl: args.resolvedAppUrl,
    baseUrl: args.resolvedBaseUrl,
    rpId: undefined,
    warnings: [],
  } as any,
  serverCorsConfig: args.serverCorsConfig,
});

describe('buildTrustedOrigins', () => {
  // -------------------------------------------------------------------------
  // Priority 1: Explicit betterAuth.trustedOrigins always wins
  // -------------------------------------------------------------------------

  it('should use betterAuth.trustedOrigins when explicitly configured (overrides serverCorsConfig)', () => {
    const result = buildTrustedOrigins(
      { trustedOrigins: ['https://explicit.example.com'] } as any,
      opts({
        resolvedAppUrl: 'https://example.com',
        serverCorsConfig: { allowedOrigins: ['https://from-cors.example.com'] },
      }),
    );
    expect(result).toEqual(['https://explicit.example.com']);
  });

  // -------------------------------------------------------------------------
  // Priority 2: serverCorsConfig disabled → empty array
  // -------------------------------------------------------------------------

  it('should return empty array when serverCorsConfig === false', () => {
    const result = buildTrustedOrigins(
      {} as any,
      opts({ resolvedAppUrl: 'https://example.com', serverCorsConfig: false }),
    );
    expect(result).toEqual([]);
  });

  it('should return empty array when serverCorsConfig.enabled === false', () => {
    const result = buildTrustedOrigins(
      {} as any,
      opts({ resolvedAppUrl: 'https://example.com', serverCorsConfig: { enabled: false } }),
    );
    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Priority 3: serverCorsConfig.allowAll → undefined (BetterAuth: allow all)
  // -------------------------------------------------------------------------

  it('should return undefined when serverCorsConfig.allowAll === true', () => {
    const result = buildTrustedOrigins(
      {} as any,
      opts({ resolvedAppUrl: 'https://example.com', serverCorsConfig: { allowAll: true } }),
    );
    expect(result).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Priority 4: serverCorsConfig.allowedOrigins → merge with resolved URLs
  // -------------------------------------------------------------------------

  it('should merge allowedOrigins with appUrl and baseUrl (deduplicated)', () => {
    const result = buildTrustedOrigins(
      {} as any,
      opts({
        resolvedAppUrl: 'https://example.com',
        resolvedBaseUrl: 'https://api.example.com',
        serverCorsConfig: { allowedOrigins: ['https://admin.example.com'] },
      }),
    );
    expect(result).toContain('https://admin.example.com');
    expect(result).toContain('https://example.com');
    expect(result).toContain('https://api.example.com');
    expect(result?.length).toBe(3);
  });

  it('should place appUrl + baseUrl BEFORE allowedOrigins for consistency with buildCorsConfig', () => {
    const result = buildTrustedOrigins(
      {} as any,
      opts({
        resolvedAppUrl: 'https://example.com',
        resolvedBaseUrl: 'https://api.example.com',
        serverCorsConfig: { allowedOrigins: ['https://admin.example.com'] },
      }),
    );
    expect(result).toEqual([
      'https://example.com',
      'https://api.example.com',
      'https://admin.example.com',
    ]);
  });

  it('should deduplicate when allowedOrigins overlaps with appUrl', () => {
    const result = buildTrustedOrigins(
      {} as any,
      opts({
        resolvedAppUrl: 'https://example.com',
        serverCorsConfig: { allowedOrigins: ['https://example.com', 'https://admin.example.com'] },
      }),
    );
    expect(result).toEqual(expect.arrayContaining(['https://example.com', 'https://admin.example.com']));
    expect(result?.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Priority 5: Passkey trustedOrigins fallback
  // -------------------------------------------------------------------------

  it('should use passkey trustedOrigins when no serverCorsConfig and passkey enabled', () => {
    const result = buildTrustedOrigins(
      {} as any,
      opts({
        passkeyEnabled: true,
        passkeyTrustedOrigins: ['https://passkey.example.com'],
        resolvedAppUrl: 'https://example.com',
      }),
    );
    expect(result).toEqual(['https://passkey.example.com']);
  });

  // -------------------------------------------------------------------------
  // Priority 6: Fallback to resolved appUrl
  // -------------------------------------------------------------------------

  it('should fallback to resolved appUrl when no other config', () => {
    const result = buildTrustedOrigins({} as any, opts({ resolvedAppUrl: 'https://example.com' }));
    expect(result).toEqual(['https://example.com']);
  });

  // -------------------------------------------------------------------------
  // Priority 7: Nothing configured → undefined (BetterAuth default)
  // -------------------------------------------------------------------------

  it('should return undefined when nothing is configured', () => {
    const result = buildTrustedOrigins({} as any, opts({}));
    expect(result).toBeUndefined();
  });
});
