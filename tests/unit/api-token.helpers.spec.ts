/**
 * API tokens — the pure half: credential formats, signed assertions, config resolution, the token
 * context marker and the per-route access decision for both token kinds.
 *
 * Everything here runs without MongoDB. The end-to-end behaviour (middleware, guards, management
 * service) lives in tests/api-token.e2e-spec.ts; this file pins the pieces whose failure would be
 * invisible there — a timing edge, a format a C#/PowerShell integrator must be able to reproduce byte
 * for byte, a spoofable principal, a role cap that could round the wrong way.
 */
import { createHmac } from 'node:crypto';

import { Controller, ForbiddenException, Get, UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Roles } from '../../src/core/common/decorators/roles.decorator';
import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { redactSensitiveText } from '../../src/core/common/helpers/logging.helper';
import { ConfigService } from '../../src/core/common/services/config.service';
import { ApiTokenKind } from '../../src/core/modules/api-token/core-api-token.constants';
import { ApiTokenScopes } from '../../src/core/modules/api-token/core-api-token.decorators';
import {
  assertApiTokenConfigIsUsable,
  attachApiTokenContext,
  capApiTokenTenantRole,
  checkApiTokenAssertionTiming,
  createTenantApiTokenPrincipal,
  decodeApiTokenAssertion,
  enforceApiTokenRoute,
  generateApiToken,
  getApiTokenContext,
  hashApiTokenSecret,
  isTenantApiTokenPrincipal,
  parseApiToken,
  readApiTokenCredential,
  readApiTokenCredentialFromHeaders,
  resolveApiTokenConfig,
  signApiTokenAssertion,
  verifyApiTokenAssertionSignature,
} from '../../src/core/modules/api-token/core-api-token.helpers';

const PUBLIC_ID = 'a1b2c3d4e5f60718293a4b5c';
const SIGNING_KEY = '0f'.repeat(32);

function useConfig(config: Record<string, unknown>): void {
  ConfigService.setConfig({ env: 'local', ...config } as any, { reInit: true, warn: false });
}

describe('API tokens — config resolution', () => {
  it.each([undefined, null, false, { enabled: false }])('is OFF for %j (no behaviour change by default)', (value) => {
    const config = resolveApiTokenConfig({ apiTokens: value as any });
    expect(config.enabled).toBe(false);
    expect(config.userTokens).toBe(false);
    expect(config.tenantTokens).toBe(false);
  });

  it('is ON with defaults for `true` and `{}` (boolean shorthand, presence implies enabled)', () => {
    for (const value of [true, {}]) {
      expect(resolveApiTokenConfig({ apiTokens: value as any, multiTenancy: {} })).toMatchObject({
        enabled: true,
        maxAssertionLifetimeSeconds: 900,
        multiTenancy: true,
        prefix: 'ltt',
        rateLimit: { max: 600, windowSeconds: 60 },
        scopes: [],
        tenantTokens: true,
        userTokens: true,
      });
    }
  });

  it('works WITHOUT multi-tenancy: user tokens on, tenant tokens off', () => {
    expect(resolveApiTokenConfig({ apiTokens: true })).toMatchObject({
      enabled: true,
      multiTenancy: false,
      tenantTokens: false,
      userTokens: true,
    });
    expect(resolveApiTokenConfig({ apiTokens: true, multiTenancy: { enabled: false } }).tenantTokens).toBe(false);
  });

  it('lets each token kind be switched off on its own', () => {
    expect(resolveApiTokenConfig({ apiTokens: { userTokens: false }, multiTenancy: {} })).toMatchObject({
      tenantTokens: true,
      userTokens: false,
    });
    expect(resolveApiTokenConfig({ apiTokens: { tenantTokens: false }, multiTenancy: {} })).toMatchObject({
      tenantTokens: false,
      userTokens: true,
    });
  });

  it('keeps rate limiting ON unless it is switched off explicitly', () => {
    expect(resolveApiTokenConfig({ apiTokens: { rateLimit: false } }).rateLimit).toBe(false);
    expect(resolveApiTokenConfig({ apiTokens: { rateLimit: { enabled: false } } }).rateLimit).toBe(false);
    expect(resolveApiTokenConfig({ apiTokens: { rateLimit: { max: 5 } } }).rateLimit).toEqual({
      max: 5,
      windowSeconds: 60,
    });
  });

  it.each([0, -1, Number.NaN, 'abc', null, true])(
    'never turns an invalid assertion lifetime (%j) into "unbounded" — it falls back to the default',
    (value) => {
      expect(
        resolveApiTokenConfig({ apiTokens: { maxAssertionLifetimeSeconds: value as any } }).maxAssertionLifetimeSeconds,
      ).toBe(900);
    },
  );

  describe('boot validation', () => {
    afterEach(() => useConfig({}));

    it('accepts the defaults, with and without multi-tenancy', () => {
      useConfig({ apiTokens: { scopes: ['read'] } });
      expect(() => assertApiTokenConfigIsUsable()).not.toThrow();
      useConfig({ apiTokens: { scopes: ['read'] }, multiTenancy: {} });
      expect(() => assertApiTokenConfigIsUsable()).not.toThrow();
    });

    it.each(['LTT', 'l', 'lt_t', 'lt-t', '1tt', 'a'.repeat(17)])('refuses the prefix %j', (prefix) => {
      useConfig({ apiTokens: { prefix } });
      expect(() => assertApiTokenConfigIsUsable()).toThrow(/prefix/);
    });

    it.each([[['']], [['has space']], [['a'.repeat(65)]], [[42]]])('refuses the scope vocabulary %j', (scopes) => {
      useConfig({ apiTokens: { scopes } });
      expect(() => assertApiTokenConfigIsUsable()).toThrow(/scope/);
    });

    it('refuses a manageRole that is not a declared tenant role', () => {
      useConfig({ apiTokens: { manageRole: 'admin' }, multiTenancy: {} });
      expect(() => assertApiTokenConfigIsUsable()).toThrow(/manageRole/);
      useConfig({ apiTokens: { manageRole: 'boss' }, multiTenancy: {} });
      expect(() => assertApiTokenConfigIsUsable()).toThrow(/manageRole/);
    });

    it('refuses a hierarchy in which a tenant token would reach the manage role — unless tenant tokens are off', () => {
      useConfig({ apiTokens: {}, multiTenancy: { roleHierarchy: { member: 1 } } });
      expect(() => assertApiTokenConfigIsUsable()).toThrow(/below/);
      useConfig({ apiTokens: { tenantTokens: false }, multiTenancy: { roleHierarchy: { member: 1 } } });
      expect(() => assertApiTokenConfigIsUsable()).not.toThrow();
    });

    it('refuses production without an encryption key, accepts it with one', () => {
      const previous = process.env.SECRETS_ENCRYPTION_KEY;
      delete process.env.SECRETS_ENCRYPTION_KEY;
      try {
        useConfig({ apiTokens: {}, env: 'production' });
        expect(() => assertApiTokenConfigIsUsable()).toThrow(/encryptionKey/);
        useConfig({ apiTokens: { encryptionKey: 'x'.repeat(32) }, env: 'production' });
        expect(() => assertApiTokenConfigIsUsable()).not.toThrow();
      } finally {
        if (previous !== undefined) process.env.SECRETS_ENCRYPTION_KEY = previous;
      }
    });
  });
});

describe('API tokens — token format', () => {
  it('generates <prefix>_<24 hex>_<64 hex> with 32 bytes of secret entropy', () => {
    const { publicId, secret, token } = generateApiToken('ltt');
    expect(token).toMatch(/^ltt_[0-9a-f]{24}_[0-9a-f]{64}$/);
    expect(token).toBe(`ltt_${publicId}_${secret}`);
    expect(generateApiToken('ltt').token).not.toBe(token);
  });

  it('parses only the exact shape, for the configured prefix', () => {
    const { publicId, secret, token } = generateApiToken('ltt');
    expect(parseApiToken(token, 'ltt')).toEqual({ publicId, secret });
    for (const bad of [
      token.toUpperCase(),
      `${token}0`,
      token.slice(0, -1),
      token.replace('ltt_', 'abc_'),
      `x${token}`,
      `ltt_${publicId}`,
      '',
    ]) {
      expect(parseApiToken(bad, 'ltt'), bad).toBeUndefined();
    }
    expect(parseApiToken(token, 'l.*')).toBeUndefined();
  });

  it('hashes the secret with SHA-256 (hex) — the stored value never equals the secret', () => {
    const hash = hashApiTokenSecret('ab'.repeat(32));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe('ab'.repeat(32));
  });

  it('reads a credential from the Authorization header, case-insensitive on "Bearer"', () => {
    const { token } = generateApiToken('ltt');
    expect(readApiTokenCredential(`Bearer ${token}`, 'ltt')).toEqual({ kind: 'token', value: token });
    expect(readApiTokenCredential(`bearer ${token}`, 'ltt')).toEqual({ kind: 'token', value: token });
    expect(readApiTokenCredential('Bearer ltts_abc.def', 'ltt')).toEqual({ kind: 'assertion', value: 'ltts_abc.def' });
    expect(readApiTokenCredential('Bearer eyJhbGciOi.eyJzdWIi.sig', 'ltt')).toBeUndefined();
    expect(readApiTokenCredential(`Basic ${token}`, 'ltt')).toBeUndefined();
    expect(readApiTokenCredential(undefined, 'ltt')).toBeUndefined();
    // A differently configured prefix does not claim someone else's credentials.
    expect(readApiTokenCredential(`Bearer ${token}`, 'acme')).toBeUndefined();
  });

  it('also reads x-api-key (the Better-Auth API-key convention) and refuses two different credentials', () => {
    const first = generateApiToken('ltt').token;
    const second = generateApiToken('ltt').token;
    expect(readApiTokenCredentialFromHeaders({ 'x-api-key': first }, 'ltt')).toEqual({ kind: 'token', value: first });
    expect(readApiTokenCredentialFromHeaders({ authorization: `Bearer ${first}`, 'x-api-key': first }, 'ltt')).toEqual({
      kind: 'token',
      value: first,
    });
    expect(readApiTokenCredentialFromHeaders({ authorization: `Bearer ${first}`, 'x-api-key': second }, 'ltt')).toBe(
      'conflict',
    );
    // A session bearer next to a token in x-api-key is not a conflict of TOKENS — the token is read.
    expect(readApiTokenCredentialFromHeaders({ authorization: 'Bearer session', 'x-api-key': first }, 'ltt')).toEqual({
      kind: 'token',
      value: first,
    });
  });
});

describe('API tokens — signed assertions', () => {
  const now = Date.UTC(2026, 8, 25, 12, 0, 0);

  it('is reproducible from its written specification (the C#/PowerShell contract)', () => {
    const assertion = signApiTokenAssertion({
      expiresAt: new Date(now + 300_000),
      nonce: 'n-1',
      publicId: PUBLIC_ID,
      signingKey: SIGNING_KEY,
      subject: 'b7user',
    });

    // Rebuilt by hand, exactly as the README describes it — no helper involved.
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor((now + 300_000) / 1000), nonce: 'n-1', sub: 'b7user', tid: PUBLIC_ID }),
      'utf8',
    ).toString('base64url');
    const signature = createHmac('sha256', Buffer.from(SIGNING_KEY, 'utf8'))
      .update(payload, 'ascii')
      .digest('base64url');
    expect(assertion).toBe(`ltts_${payload}.${signature}`);
  });

  it('decodes and verifies what it signed', () => {
    const assertion = signApiTokenAssertion({
      claims: { b7Company: '001' },
      expiresInSeconds: 60,
      publicId: PUBLIC_ID,
      signingKey: SIGNING_KEY,
    });
    const decoded = decodeApiTokenAssertion(assertion, 'ltt')!;
    expect(decoded.payload).toMatchObject({ claims: { b7Company: '001' }, tid: PUBLIC_ID });
    expect(verifyApiTokenAssertionSignature(decoded.payloadSegment, decoded.signature, SIGNING_KEY)).toBe(true);
    expect(verifyApiTokenAssertionSignature(decoded.payloadSegment, decoded.signature, 'ab'.repeat(32))).toBe(false);
  });

  it('rejects a payload that was altered after signing', () => {
    const assertion = signApiTokenAssertion({ expiresInSeconds: 60, publicId: PUBLIC_ID, signingKey: SIGNING_KEY });
    const decoded = decodeApiTokenAssertion(assertion, 'ltt')!;
    const forged = Buffer.from(JSON.stringify({ ...decoded.payload, exp: decoded.payload.exp + 3600 })).toString(
      'base64url',
    );
    expect(verifyApiTokenAssertionSignature(forged, decoded.signature, SIGNING_KEY)).toBe(false);
  });

  it.each([
    'ltts_',
    'ltts_abc',
    'ltts_abc.def.ghi',
    `ltts_${Buffer.from('not json').toString('base64url')}.sig`,
    `ltts_${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.sig`,
    `ltts_${Buffer.from(JSON.stringify({ exp: 'soon', tid: PUBLIC_ID })).toString('base64url')}.sig`,
    `ltts_${Buffer.from(JSON.stringify({ claims: [1], exp: 1, tid: PUBLIC_ID })).toString('base64url')}.sig`,
    `ltts_${Buffer.from(JSON.stringify({ exp: 1, tid: 'not-hex' })).toString('base64url')}.sig`,
    `ltts_${'a'.repeat(9000)}.sig`,
  ])('refuses the malformed assertion %s', (value) => {
    expect(decodeApiTokenAssertion(value, 'ltt')).toBeUndefined();
  });

  it('accepts a live assertion within the maximum lifetime', () => {
    expect(checkApiTokenAssertionTiming({ exp: Math.floor(now / 1000) + 600 }, 900, now)).toBe('ok');
  });

  it('refuses an expired assertion, allowing 30 s of clock skew', () => {
    expect(checkApiTokenAssertionTiming({ exp: Math.floor(now / 1000) - 20 }, 900, now)).toBe('ok');
    expect(checkApiTokenAssertionTiming({ exp: Math.floor(now / 1000) - 31 }, 900, now)).toBe('expired');
  });

  it('refuses an assertion that would live longer than the configured maximum', () => {
    expect(checkApiTokenAssertionTiming({ exp: Math.floor(now / 1000) + 930 }, 900, now)).toBe('ok');
    expect(checkApiTokenAssertionTiming({ exp: Math.floor(now / 1000) + 931 }, 900, now)).toBe('too-long');
  });
});

describe('API tokens — context marker', () => {
  const tenantContext = {
    name: 'ERP',
    publicId: PUBLIC_ID,
    scopes: ['read'],
    tenantId: 't1',
    tokenId: '65f000000000000000000001',
  };

  it('recognises a tenant-token principal created by the framework', () => {
    const principal = createTenantApiTokenPrincipal(tenantContext);
    expect(isTenantApiTokenPrincipal(principal)).toBe(true);
    expect(getApiTokenContext(principal)).toMatchObject({ kind: ApiTokenKind.TENANT, tenantId: 't1' });
    expect(principal).toMatchObject({ id: '65f000000000000000000001', roles: [], tenantId: 't1' });
    expect(principal.hasRole([RoleEnum.ADMIN])).toBe(false);
  });

  it('marks a user object without changing what it is', () => {
    const user = attachApiTokenContext(
      { id: 'u1', roles: [] },
      { ...tenantContext, kind: ApiTokenKind.USER, tenantId: undefined, userId: 'u1' },
    );
    expect(isTenantApiTokenPrincipal(user)).toBe(false);
    expect(getApiTokenContext(user)).toMatchObject({ kind: ApiTokenKind.USER, userId: 'u1' });
    expect(Object.isFrozen(getApiTokenContext(user))).toBe(true);
  });

  it('cannot be forged from data — an object that merely LOOKS like a token is not one', () => {
    const principal = createTenantApiTokenPrincipal(tenantContext);
    // What a user document carrying the same fields, or a JSON round trip, would produce.
    expect(getApiTokenContext(JSON.parse(JSON.stringify(principal)))).toBeUndefined();
    expect(getApiTokenContext({ kind: ApiTokenKind.TENANT, scopes: ['read'], tenantId: 't1' })).toBeUndefined();
    expect(getApiTokenContext(undefined)).toBeUndefined();
  });
});

describe('API tokens — route access decision', () => {
  @Controller('x')
  class Probe {
    @ApiTokenScopes('read')
    @Get('read')
    @Roles(RoleEnum.S_USER)
    read() {}

    @Get('unreleased')
    @Roles(RoleEnum.S_USER)
    unreleased() {}

    @Get('public')
    @Roles(RoleEnum.S_EVERYONE)
    public() {}

    @ApiTokenScopes('read')
    @Get('member')
    @Roles('member')
    member() {}

    @ApiTokenScopes('read')
    @Get('owner')
    @Roles('owner')
    owner() {}

    @ApiTokenScopes('read')
    @Get('admin')
    @Roles(RoleEnum.ADMIN)
    admin() {}

    @ApiTokenScopes('read')
    @Get('locked')
    @Roles(RoleEnum.S_NO_ONE)
    locked() {}

    @ApiTokenScopes('export', 'upload')
    @Get('export')
    exportIt() {}

    @ApiTokenScopes('read')
    @Get('self/:id')
    @Roles(RoleEnum.S_SELF)
    self() {}

    @ApiTokenScopes('read')
    @Get('creator/:id')
    @Roles(RoleEnum.S_CREATOR)
    creator() {}

    @ApiTokenScopes('read')
    @Get('self-or-member/:id')
    @Roles(RoleEnum.S_SELF, 'member')
    selfOrMember() {}
  }

  @ApiTokenScopes('read')
  @Roles(RoleEnum.S_USER)
  @Controller('y')
  class ReleasedClass {
    @Get('inherits')
    inherits() {}

    @ApiTokenScopes('export')
    @Get('narrowed')
    narrowed() {}
  }

  const tenantPrincipal = () =>
    createTenantApiTokenPrincipal({
      name: 'ERP',
      publicId: PUBLIC_ID,
      scopes: ['read'],
      tenantId: 'tenant-a',
      tokenId: '65f000000000000000000001',
    });

  const userWithToken = (extra: Record<string, unknown> = {}) =>
    attachApiTokenContext(
      { id: 'u1', roles: [] },
      {
        kind: ApiTokenKind.USER,
        name: 'CLI',
        publicId: PUBLIC_ID,
        scopes: ['read'],
        tokenId: '65f000000000000000000002',
        userId: 'u1',
        ...extra,
      },
    );

  function decide(cls: any, method: string, user: any, headers: Record<string, string> = {}) {
    const request: any = { headers, user };
    const kind = enforceApiTokenRoute({ controllerClass: cls, handler: cls.prototype[method], request });
    return { kind, request };
  }

  beforeEach(() => useConfig({ apiTokens: { scopes: ['read', 'export', 'upload'] }, multiTenancy: {} }));
  afterEach(() => useConfig({}));

  describe('tenant token', () => {
    it('binds a released route to the token tenant with the LOWEST hierarchy role', () => {
      const { kind, request } = decide(Probe, 'read', tenantPrincipal());
      expect(kind).toBe(ApiTokenKind.TENANT);
      expect(request.tenantId).toBe('tenant-a');
      expect(request.tenantRole).toBe('member');
      expect(request.isAdminBypass).toBe(false);
    });

    it('accepts the own tenant in the header and refuses any other', () => {
      expect(decide(Probe, 'read', tenantPrincipal(), { 'x-tenant-id': 'tenant-a' }).request.tenantId).toBe('tenant-a');
      expect(() => decide(Probe, 'read', tenantPrincipal(), { 'x-tenant-id': 'tenant-b' })).toThrow(ForbiddenException);
    });

    it('denies by default — a route without @ApiTokenScopes is closed, public ones included', () => {
      expect(() => decide(Probe, 'unreleased', tenantPrincipal())).toThrow(ForbiddenException);
      expect(() => decide(Probe, 'public', tenantPrincipal())).toThrow(ForbiddenException);
    });

    it('requires one of the listed scopes', () => {
      expect(() => decide(Probe, 'exportIt', tenantPrincipal())).toThrow(ForbiddenException);
    });

    it('satisfies the lowest tenant role, never a higher one and never a global one', () => {
      expect(() => decide(Probe, 'member', tenantPrincipal())).not.toThrow();
      expect(() => decide(Probe, 'owner', tenantPrincipal())).toThrow(ForbiddenException);
      expect(() => decide(Probe, 'admin', tenantPrincipal())).toThrow(ForbiddenException);
      expect(() => decide(Probe, 'locked', tenantPrincipal())).toThrow(ForbiddenException);
    });

    it('reads the release from the class, and a method-level release overrides it', () => {
      expect(() => decide(ReleasedClass, 'inherits', tenantPrincipal())).not.toThrow();
      expect(() => decide(ReleasedClass, 'narrowed', tenantPrincipal())).toThrow(ForbiddenException);
    });

    /**
     * @regression   11.41.4 (pre-release) — S_SELF and S_CREATOR were filtered out as system roles and
     *   then nothing was left to check, so a tenant token passed a released `@Roles(S_SELF)` route for
     *   ANY target id. The guard's own S_SELF comparison never ran, because a tenant token is decided
     *   before it. A route like `GET /users/:id` opened for "a token may read its own user" was thereby
     *   readable for every user by any tenant token carrying the scope.
     * @seen-failing Drop the "only object-level system roles left" refusal from
     *   `assertTenantApiTokenRouteAccess()` in src/core/modules/api-token/core-api-token.helpers.ts —
     *   registered as mutation `tenant-token-passes-object-level-system-roles` in
     *   tests/regression-mutations.json.
     */
    it("refuses a route guarded only by S_SELF or S_CREATOR — a tenant token is nobody's self", () => {
      const withTarget = (method: string, user: any) => {
        const request: any = { headers: {}, params: { id: '65f0000000000000000000ff' }, user };
        return enforceApiTokenRoute({ controllerClass: Probe, handler: (Probe.prototype as any)[method], request });
      };
      expect(() => withTarget('self', tenantPrincipal())).toThrow(ForbiddenException);
      expect(() => withTarget('creator', tenantPrincipal())).toThrow(ForbiddenException);
      // Paired control: an OR with a tenant role still resolves through the lowest role …
      expect(withTarget('selfOrMember', tenantPrincipal())).toBe(ApiTokenKind.TENANT);
      // … and a USER token is not refused here: its user IS a self, which the ordinary guard compares.
      expect(withTarget('self', userWithToken())).toBe(ApiTokenKind.USER);
    });
  });

  describe('user token', () => {
    it('passes the scope check and leaves the role decision to the ordinary guards', () => {
      const { kind, request } = decide(Probe, 'owner', userWithToken());
      expect(kind).toBe(ApiTokenKind.USER);
      // Nothing is bound here — the user's own membership decides, in CoreTenantGuard.
      expect(request.tenantId).toBeUndefined();
    });

    it('is denied by default and needs a released scope, like a tenant token', () => {
      expect(() => decide(Probe, 'unreleased', userWithToken())).toThrow(ForbiddenException);
      expect(() => decide(Probe, 'public', userWithToken())).toThrow(ForbiddenException);
      expect(() => decide(Probe, 'exportIt', userWithToken())).toThrow(ForbiddenException);
    });

    it('keeps a tenant-restricted token out of every other tenant', () => {
      expect(() =>
        decide(Probe, 'read', userWithToken({ tenantId: 'tenant-a' }), { 'x-tenant-id': 'tenant-b' }),
      ).toThrow(ForbiddenException);
      expect(decide(Probe, 'read', userWithToken({ tenantId: 'tenant-a' }), { 'x-tenant-id': 'tenant-a' }).kind).toBe(
        ApiTokenKind.USER,
      );
    });
  });

  it('refuses with 401 a token credential that reached the guard unauthenticated', () => {
    const { token } = generateApiToken('ltt');
    expect(() =>
      enforceApiTokenRoute({
        controllerClass: Probe,
        handler: Probe.prototype.read,
        request: { headers: { authorization: `Bearer ${token}` } },
      }),
    ).toThrow(UnauthorizedException);
  });

  it('ignores ordinary requests', () => {
    expect(decide(Probe, 'unreleased', { id: 'u1', roles: [] }).kind).toBeUndefined();
    expect(decide(Probe, 'unreleased', undefined).kind).toBeUndefined();
  });
});

describe('API tokens — tenant role cap of user tokens', () => {
  beforeEach(() => useConfig({ apiTokens: {}, multiTenancy: {} }));
  afterEach(() => useConfig({}));

  const capped = (maxTenantRole?: string) =>
    attachApiTokenContext(
      { id: 'u1', roles: [] },
      {
        kind: ApiTokenKind.USER,
        maxTenantRole,
        name: 'x',
        publicId: PUBLIC_ID,
        scopes: [],
        tokenId: 't',
        userId: 'u1',
      },
    );

  it('lowers a higher membership role to the cap and leaves a lower one untouched', () => {
    expect(capApiTokenTenantRole(capped('manager'), 'owner')).toBe('manager');
    expect(capApiTokenTenantRole(capped('manager'), 'member')).toBe('member');
  });

  it('leaves sessions and uncapped tokens alone', () => {
    expect(capApiTokenTenantRole({ id: 'u1' }, 'owner')).toBe('owner');
    expect(capApiTokenTenantRole(capped(undefined), 'owner')).toBe('owner');
  });

  it('fails closed for a role the hierarchy cannot compare', () => {
    expect(capApiTokenTenantRole(capped('manager'), 'auditor')).toBeNull();
  });
});

describe('API tokens — log redaction', () => {
  it('masks a token and an assertion anywhere in a log line', () => {
    const { token } = generateApiToken('ltt');
    const assertion = signApiTokenAssertion({ expiresInSeconds: 60, publicId: PUBLIC_ID, signingKey: SIGNING_KEY });
    const line = redactSensitiveText(`upload failed for ${token} via ${assertion}`);
    expect(line).not.toContain(token.slice(4));
    expect(line).not.toContain(assertion.slice(5));
  });
});
