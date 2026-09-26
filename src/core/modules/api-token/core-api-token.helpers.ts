import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

import { isForbiddenMembershipRole, RoleEnum } from '../../common/enums/role.enum';
import { isProductionLikeEnv } from '../../common/helpers/cookies.helper';
import type { IApiTokens, IMultiTenancy } from '../../common/interfaces/server-options.interface';
import { ConfigService } from '../../common/services/config.service';
import { ErrorCode } from '../error-code/error-codes';
import { DEFAULT_ROLE_HIERARCHY } from '../tenant/core-tenant.enums';
import {
  checkRoleAccess,
  isSystemRole,
  mergeRolesMetadata,
  tenantSatisfiableRoles,
} from '../tenant/core-tenant.helpers';
import { API_TOKEN_SCOPES_KEY, ApiTokenKind } from './core-api-token.constants';

// =====================================================================================================================
// Configuration
// =====================================================================================================================

/** Defaults of the `apiTokens` config. */
export const API_TOKEN_DEFAULTS = {
  maxAssertionLifetimeSeconds: 900,
  prefix: 'ltt',
  rateLimit: { max: 600, windowSeconds: 60 },
} as const;

/** Clock skew tolerated on both edges of an assertion's lifetime. */
export const API_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;

/** Upper bound for an assertion, so a request cannot make the server parse an arbitrarily large payload. */
export const API_TOKEN_MAX_ASSERTION_LENGTH = 8192;

/** Header accepted besides `Authorization: Bearer`, matching the convention of Better-Auth's API-key plugin. */
export const API_TOKEN_HEADER = 'x-api-key';

const PREFIX_PATTERN = /^[a-z][a-z0-9]{1,15}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9:._-]{1,64}$/;
const PUBLIC_ID_PATTERN = /^[0-9a-f]{24}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** `apiTokens` after defaults and normalisation. */
export interface IResolvedApiTokenConfig {
  enabled: boolean;
  encryptionKey?: string;
  manageRole?: string;
  maxAssertionLifetimeSeconds: number;
  /** Whether multi-tenancy is active — tenant tokens and tenant restrictions exist only then. */
  multiTenancy: boolean;
  prefix: string;
  rateLimit: false | { max: number; windowSeconds: number };
  scopes: string[];
  /** Tenant tokens allowed AND multi-tenancy active. */
  tenantTokens: boolean;
  userTokens: boolean;
}

/**
 * Normalise the server config into the effective API-token configuration.
 *
 * Boolean shorthand: absent / `false` / `{ enabled: false }` → off; `true` / `{}` → on with defaults.
 * Pure — reads nothing but its argument; {@link getApiTokenConfig} reads the running config.
 */
export function resolveApiTokenConfig(
  config: null | undefined | { apiTokens?: boolean | IApiTokens; multiTenancy?: IMultiTenancy },
): IResolvedApiTokenConfig {
  const raw = config?.apiTokens;
  const options: IApiTokens = typeof raw === 'object' && raw !== null ? raw : {};
  const enabled = raw === true || (typeof raw === 'object' && raw !== null && raw.enabled !== false);
  const multiTenancy = !!config?.multiTenancy && config.multiTenancy.enabled !== false;

  const lifetime = Number(options.maxAssertionLifetimeSeconds);
  return {
    enabled,
    encryptionKey:
      typeof options.encryptionKey === 'string' && options.encryptionKey ? options.encryptionKey : undefined,
    manageRole: typeof options.manageRole === 'string' && options.manageRole ? options.manageRole : undefined,
    // An invalid value falls back to the default, never to "unbounded": this knob bounds the lifetime
    // of a credential, so a typo must not be the thing that switches the bound off.
    maxAssertionLifetimeSeconds:
      options.maxAssertionLifetimeSeconds !== null &&
      typeof options.maxAssertionLifetimeSeconds !== 'boolean' &&
      Number.isFinite(lifetime) &&
      lifetime > 0
        ? Math.floor(lifetime)
        : API_TOKEN_DEFAULTS.maxAssertionLifetimeSeconds,
    multiTenancy,
    prefix: typeof options.prefix === 'string' ? options.prefix : API_TOKEN_DEFAULTS.prefix,
    rateLimit: resolveRateLimit(options.rateLimit),
    scopes: Array.isArray(options.scopes) ? [...options.scopes] : [],
    tenantTokens: enabled && multiTenancy && options.tenantTokens !== false,
    userTokens: enabled && options.userTokens !== false,
  };
}

function resolveRateLimit(value: unknown): IResolvedApiTokenConfig['rateLimit'] {
  if (value === false || (typeof value === 'object' && value !== null && (value as any).enabled === false)) {
    return false;
  }
  const options =
    typeof value === 'object' && value !== null ? (value as { max?: unknown; windowSeconds?: unknown }) : {};
  const max = Number(options.max);
  const windowSeconds = Number(options.windowSeconds);
  return {
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : API_TOKEN_DEFAULTS.rateLimit.max,
    windowSeconds:
      Number.isFinite(windowSeconds) && windowSeconds > 0
        ? Math.floor(windowSeconds)
        : API_TOKEN_DEFAULTS.rateLimit.windowSeconds,
  };
}

/** The effective API-token configuration of the running server. */
export function getApiTokenConfig(): IResolvedApiTokenConfig {
  return resolveApiTokenConfig(ConfigService.configFastButReadOnly);
}

/** Configured role hierarchy (or the default). */
function hierarchy(): Record<string, number> {
  return ConfigService.configFastButReadOnly?.multiTenancy?.roleHierarchy ?? DEFAULT_ROLE_HIERARCHY;
}

/**
 * The tenant role a TENANT token acts with: the LOWEST role of the hierarchy. A tenant token is a
 * member of its tenant, never more — it cannot reach the role that manages tokens (enforced at boot).
 */
export function getApiTokenTenantMemberRole(): string {
  const entries = Object.entries(hierarchy());
  if (entries.length === 0) {
    return 'member';
  }
  return entries.reduce((a, b) => (a[1] <= b[1] ? a : b))[0];
}

/** The tenant role required to manage tenant tokens: configured, or the highest role of the hierarchy. */
export function getApiTokenManageRole(config: IResolvedApiTokenConfig = getApiTokenConfig()): string {
  if (config.manageRole) {
    return config.manageRole;
  }
  const entries = Object.entries(hierarchy());
  if (entries.length === 0) {
    return 'owner';
  }
  return entries.reduce((a, b) => (a[1] >= b[1] ? a : b))[0];
}

/** The encryption pass-phrase for signing keys, or `undefined` when none is configured. */
export function resolveApiTokenEncryptionKey(
  config: IResolvedApiTokenConfig = getApiTokenConfig(),
): string | undefined {
  return config.encryptionKey || process.env.SECRETS_ENCRYPTION_KEY || undefined;
}

/**
 * Refuse, at boot, a token configuration that cannot be enforced as written. Each condition describes
 * a setup whose failure would otherwise surface only at the first request — or never.
 */
export function assertApiTokenConfigIsUsable(): void {
  const config = getApiTokenConfig();
  if (!config.enabled) {
    return;
  }

  if (!PREFIX_PATTERN.test(config.prefix)) {
    throw new Error(
      `apiTokens.prefix "${config.prefix}" is invalid: use 2-16 lowercase letters and digits, starting with ` +
        'a letter. The prefix is how the server tells a token apart from every other credential.',
    );
  }

  const invalidScopes = config.scopes.filter((scope) => typeof scope !== 'string' || !SCOPE_PATTERN.test(scope));
  if (invalidScopes.length) {
    throw new Error(
      `apiTokens.scopes contains invalid scope(s) ${JSON.stringify(invalidScopes)}: ` +
        'use 1-64 characters of letters, digits, ":", ".", "_" or "-".',
    );
  }

  if (config.tenantTokens) {
    const multiTenancy = ConfigService.configFastButReadOnly?.multiTenancy;
    const declared = new Set([...Object.keys(hierarchy()), ...(multiTenancy?.additionalMembershipRoles ?? [])]);
    const manageRole = getApiTokenManageRole(config);
    if (isForbiddenMembershipRole(manageRole) || !declared.has(manageRole)) {
      throw new Error(
        `apiTokens.manageRole "${manageRole}" is not a declared tenant role. ` +
          `Declared: [${[...declared].sort().join(', ')}]. Managing tenant tokens is a tenant right, so it ` +
          'needs a role from roleHierarchy or additionalMembershipRoles — never a global or system role.',
      );
    }

    const levels = hierarchy();
    const memberRole = getApiTokenTenantMemberRole();
    if (manageRole in levels && levels[memberRole] >= levels[manageRole]) {
      throw new Error(
        `apiTokens needs a tenant role hierarchy with a role below "${manageRole}": a tenant token acts with ` +
          `the lowest role ("${memberRole}"), and in this hierarchy that role already reaches the role that ` +
          'manages tokens — a token would count as a tenant administrator. Set apiTokens.tenantTokens: false ' +
          'if you only need user tokens.',
      );
    }
  }

  if (isProductionLikeEnv(ConfigService.configFastButReadOnly?.env) && !resolveApiTokenEncryptionKey(config)) {
    throw new Error(
      'apiTokens.encryptionKey (or SECRETS_ENCRYPTION_KEY) is required in production/staging. ' +
        'Without it, the signing keys of all tokens are encrypted with a public development default. ' +
        'Set a random value of 32+ characters.',
    );
  }
}

// =====================================================================================================================
// Credential formats
// =====================================================================================================================

/** A credential found in a request header. */
export interface IApiTokenCredential {
  kind: 'assertion' | 'token';
  value: string;
}

function classify(value: string, prefix: string): IApiTokenCredential | undefined {
  if (value.startsWith(`${prefix}_`)) {
    return { kind: 'token', value };
  }
  if (value.startsWith(`${prefix}s_`)) {
    return { kind: 'assertion', value };
  }
  return undefined;
}

/**
 * Read an API credential from an `Authorization` header value.
 *
 * Recognised purely by prefix — `<prefix>_` for a token, `<prefix>s_` for an assertion — so Better-Auth
 * sessions, JWTs and legacy tokens are never claimed by mistake. `Bearer` is matched case-insensitively
 * (the framework's TestHelper sends `bearer`).
 */
export function readApiTokenCredential(
  authorization: string | string[] | undefined,
  prefix: string,
): IApiTokenCredential | undefined {
  if (typeof authorization !== 'string') {
    return undefined;
  }
  const match = /^bearer\s+(\S+)\s*$/i.exec(authorization);
  return match ? classify(match[1], prefix) : undefined;
}

/**
 * Read an API credential from a request's headers: `Authorization: Bearer <credential>` or
 * `x-api-key: <credential>`. Two DIFFERENT credentials in the two headers are ambiguous and answered
 * with `conflict` — the caller must refuse, never pick one.
 */
export function readApiTokenCredentialFromHeaders(
  headers: Record<string, any> | undefined,
  prefix: string,
): 'conflict' | IApiTokenCredential | undefined {
  const fromAuthorization = readApiTokenCredential(headers?.authorization, prefix);
  const apiKeyHeader = headers?.[API_TOKEN_HEADER];
  const fromApiKey = typeof apiKeyHeader === 'string' ? classify(apiKeyHeader.trim(), prefix) : undefined;
  if (fromAuthorization && fromApiKey && fromAuthorization.value !== fromApiKey.value) {
    return 'conflict';
  }
  return fromAuthorization ?? fromApiKey;
}

/**
 * Does this request carry an API credential? Always `false` while the feature is off, so a token-shaped
 * value on a server without API tokens is handled like any other unknown credential.
 */
export function hasApiTokenCredential(request: { headers?: Record<string, any> } | undefined): boolean {
  const config = getApiTokenConfig();
  return config.enabled && !!readApiTokenCredentialFromHeaders(request?.headers, config.prefix);
}

/** Generate a new token: `<prefix>_<publicId: 24 hex>_<secret: 64 hex>` (32 bytes of secret entropy). */
export function generateApiToken(prefix: string): { publicId: string; secret: string; token: string } {
  const publicId = randomBytes(12).toString('hex');
  const secret = randomBytes(32).toString('hex');
  return { publicId, secret, token: `${prefix}_${publicId}_${secret}` };
}

/** Split a token into its public id and secret — only the exact shape for the given prefix is accepted. */
export function parseApiToken(value: string, prefix: string): undefined | { publicId: string; secret: string } {
  // The prefix is interpolated into a pattern, so it must be the validated shape — never raw config.
  if (!PREFIX_PATTERN.test(prefix)) {
    return undefined;
  }
  const match = new RegExp(`^${prefix}_([0-9a-f]{24})_([0-9a-f]{64})$`).exec(value ?? '');
  return match ? { publicId: match[1], secret: match[2] } : undefined;
}

/**
 * Hash a token secret for storage. SHA-256 rather than a slow KDF on purpose: the secret carries 256
 * bits of randomness, so there is nothing for a slow hash to protect, and every request pays for it.
 */
export function hashApiTokenSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex strings (different lengths compare unequal). */
export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a ?? '', 'hex');
  const right = Buffer.from(b ?? '', 'hex');
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

/** Generate a signing key: 32 random bytes as 64 hex characters. */
export function generateApiTokenSigningKey(): string {
  return randomBytes(32).toString('hex');
}

// =====================================================================================================================
// Signed assertions
// =====================================================================================================================

/** The payload of a signed assertion. */
export interface IApiTokenAssertionPayload {
  /** Free-form claims for the audit trail (e.g. the embedding application's company). */
  claims?: Record<string, unknown>;
  /** Expiry, Unix seconds. */
  exp: number;
  /** Carried for the audit trail only — NOT enforced as single-use, an embedded page reuses one assertion. */
  nonce?: string;
  /** Who, inside the embedding application, the assertion speaks for (e.g. a user name). */
  sub?: string;
  /** Public id of the token whose signing key signed the assertion. */
  tid: string;
}

/** Options for {@link signApiTokenAssertion}. */
export interface ISignApiTokenAssertionOptions {
  claims?: Record<string, unknown>;
  /** Absolute expiry (Date or epoch milliseconds). Takes precedence over `expiresInSeconds`. */
  expiresAt?: Date | number;
  /** Relative expiry. @default 300 */
  expiresInSeconds?: number;
  nonce?: string;
  /** @default 'ltt' */
  prefix?: string;
  publicId: string;
  signingKey: string;
  subject?: string;
}

/**
 * Mint a signed assertion — for Node integrators and tests. Other languages follow the same recipe:
 *
 * 1. payload = base64url (no padding) of the UTF-8 JSON `{ claims?, exp, nonce?, sub?, tid }`
 * 2. signature = base64url (no padding) of HMAC-SHA256, key = the UTF-8 bytes of the signing key
 *    exactly as issued (64 hex characters), data = the ASCII bytes of the payload string from step 1
 * 3. assertion = `<prefix>s_<payload>.<signature>`
 *
 * The server verifies the signature over the payload string as received, so key order and whitespace
 * inside the JSON do not matter.
 */
export function signApiTokenAssertion(options: ISignApiTokenAssertionOptions): string {
  const prefix = options.prefix ?? API_TOKEN_DEFAULTS.prefix;
  const expiresAtMs =
    options.expiresAt !== undefined
      ? new Date(options.expiresAt).getTime()
      : Date.now() + (options.expiresInSeconds ?? 300) * 1000;

  // Alphabetical key order, so the documented example can be reproduced byte for byte.
  const payload: Record<string, unknown> = {};
  if (options.claims !== undefined) payload.claims = options.claims;
  payload.exp = Math.floor(expiresAtMs / 1000);
  if (options.nonce !== undefined) payload.nonce = options.nonce;
  if (options.subject !== undefined) payload.sub = options.subject;
  payload.tid = options.publicId;

  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${prefix}s_${payloadSegment}.${signAssertionPayload(payloadSegment, options.signingKey).toString('base64url')}`;
}

function signAssertionPayload(payloadSegment: string, signingKey: string): Buffer {
  return createHmac('sha256', Buffer.from(signingKey, 'utf8')).update(payloadSegment, 'ascii').digest();
}

/**
 * Parse an assertion WITHOUT verifying it. Returns `undefined` for anything that is not structurally a
 * valid assertion for the prefix; the signature and the timing are checked separately.
 */
export function decodeApiTokenAssertion(
  value: string,
  prefix: string,
): undefined | { payload: IApiTokenAssertionPayload; payloadSegment: string; signature: string } {
  const head = `${prefix}s_`;
  if (typeof value !== 'string' || value.length > API_TOKEN_MAX_ASSERTION_LENGTH || !value.startsWith(head)) {
    return undefined;
  }
  const parts = value.slice(head.length).split('.');
  if (parts.length !== 2) {
    return undefined;
  }
  const [payloadSegment, signature] = parts;
  if (!BASE64URL_PATTERN.test(payloadSegment) || !BASE64URL_PATTERN.test(signature)) {
    return undefined;
  }

  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  if (typeof payload.tid !== 'string' || !PUBLIC_ID_PATTERN.test(payload.tid) || !Number.isInteger(payload.exp)) {
    return undefined;
  }
  for (const field of ['sub', 'nonce'] as const) {
    if (payload[field] !== undefined && (typeof payload[field] !== 'string' || payload[field].length > 256)) {
      return undefined;
    }
  }
  if (
    payload.claims !== undefined &&
    (payload.claims === null || typeof payload.claims !== 'object' || Array.isArray(payload.claims))
  ) {
    return undefined;
  }

  return {
    payload: { claims: payload.claims, exp: payload.exp, nonce: payload.nonce, sub: payload.sub, tid: payload.tid },
    payloadSegment,
    signature,
  };
}

/** Verify an assertion's HMAC in constant time. */
export function verifyApiTokenAssertionSignature(
  payloadSegment: string,
  signature: string,
  signingKey: string,
): boolean {
  const expected = signAssertionPayload(payloadSegment, signingKey);
  const provided = Buffer.from(signature, 'base64url');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Check an assertion's lifetime: not expired, and not valid for longer than the configured maximum
 * from now. Both edges tolerate {@link API_TOKEN_CLOCK_TOLERANCE_SECONDS} of clock skew.
 */
export function checkApiTokenAssertionTiming(
  payload: Pick<IApiTokenAssertionPayload, 'exp'> & Partial<IApiTokenAssertionPayload>,
  maxLifetimeSeconds: number,
  now: number = Date.now(),
): 'expired' | 'ok' | 'too-long' {
  const nowSeconds = Math.floor(now / 1000);
  if (payload.exp + API_TOKEN_CLOCK_TOLERANCE_SECONDS < nowSeconds) {
    return 'expired';
  }
  if (payload.exp - nowSeconds > maxLifetimeSeconds + API_TOKEN_CLOCK_TOLERANCE_SECONDS) {
    return 'too-long';
  }
  return 'ok';
}

// =====================================================================================================================
// Token context on request.user
// =====================================================================================================================

/**
 * Module-private marker. A token is recognised by this symbol, never by a data field: a user document
 * that happened to carry `tenantId` and `scopes` must not be mistaken for a token — it would be bound to
 * that tenant without being a member of it. JSON drops symbols, so the marker cannot travel through a
 * database or a request body.
 */
const API_TOKEN_CONTEXT = Symbol('apiTokenContext');

/** What the framework knows about the token a request was authenticated with. */
export interface IApiTokenContext {
  /** Present when the request carried a signed assertion instead of the token itself. */
  assertion?: {
    claims?: Record<string, unknown>;
    expiresAt: Date;
    nonce?: string;
    subject?: string;
  };
  kind: ApiTokenKind;
  /** USER tokens: the highest tenant role the token may act with (a cap, never a grant). */
  maxTenantRole?: string;
  name: string;
  publicId: string;
  scopes: string[];
  /** TENANT tokens: the owning tenant. USER tokens: the one tenant the token is restricted to, if any. */
  tenantId?: string;
  tokenId: string;
  /** USER tokens: the owning user. */
  userId?: string;
}

/** What `request.user` holds for a request authenticated with a TENANT token. */
export interface ITenantApiTokenPrincipal {
  /** Always false — a tenant token holds no global role. */
  hasRole: (roles?: string | string[]) => boolean;
  /** The token document id (also written to `createdBy` / `updatedBy` by the audit plugin). */
  id: string;
  name: string;
  /** Always empty — a tenant token holds no global role. */
  roles: string[];
  scopes: string[];
  tenantId: string;
}

/**
 * The token a request was authenticated with, or `undefined` for a session, a JWT or an anonymous
 * request. Works for both kinds: pass `request.user` / `@CurrentUser()`.
 */
export function getApiTokenContext(user: unknown): IApiTokenContext | undefined {
  return user && typeof user === 'object' ? ((user as any)[API_TOKEN_CONTEXT] as IApiTokenContext) : undefined;
}

/** Attach a token context to a request user. Only the framework's authentication path should need this. */
export function attachApiTokenContext<T extends object>(user: T, context: IApiTokenContext): T {
  (user as any)[API_TOKEN_CONTEXT] = Object.freeze({ ...context, scopes: [...context.scopes] });
  return user;
}

/** Build the principal of a TENANT token. Only the framework's authentication path should need this. */
export function createTenantApiTokenPrincipal(
  context: Omit<IApiTokenContext, 'kind' | 'maxTenantRole' | 'userId'> & { tenantId: string },
): ITenantApiTokenPrincipal {
  const principal: ITenantApiTokenPrincipal = {
    hasRole: () => false,
    id: context.tokenId,
    name: context.name,
    roles: [],
    scopes: [...context.scopes],
    tenantId: context.tenantId,
  };
  return attachApiTokenContext(principal, { ...context, kind: ApiTokenKind.TENANT });
}

/** Is this `request.user` the principal of a TENANT token? */
export function isTenantApiTokenPrincipal(user: unknown): user is ITenantApiTokenPrincipal {
  return getApiTokenContext(user)?.kind === ApiTokenKind.TENANT;
}

// =====================================================================================================================
// Route access
// =====================================================================================================================

function denied(): ForbiddenException {
  return new ForbiddenException(ErrorCode.ACCESS_DENIED);
}

function tenantHeaderName(): string {
  return (ConfigService.configFastButReadOnly?.multiTenancy?.headerName ?? 'x-tenant-id').toLowerCase();
}

/**
 * Refuse a token on a route that did not release it, or that releases other scopes only.
 * `@ApiTokenScopes()` on the method replaces the class-level declaration.
 */
export function assertApiTokenScopes(context: IApiTokenContext, handler: any, controllerClass: any): void {
  const handlerScopes = handler
    ? (Reflect.getMetadata(API_TOKEN_SCOPES_KEY, handler) as string[] | undefined)
    : undefined;
  const requiredScopes =
    handlerScopes ??
    (controllerClass
      ? (Reflect.getMetadata(API_TOKEN_SCOPES_KEY, controllerClass) as string[] | undefined)
      : undefined);
  if (!requiredScopes?.length || !requiredScopes.some((scope) => context.scopes.includes(scope))) {
    throw denied();
  }
}

/**
 * Decide the roles of a route for a TENANT token and bind the request to the token's tenant.
 *
 * `S_NO_ONE` refuses; `S_EVERYONE` / `S_USER` / `S_VERIFIED` count as satisfied (the route released
 * tokens explicitly); other roles are resolved against the LOWEST tenant role — global roles never
 * match. A route guarded ONLY by object-level system roles (`S_SELF`, `S_CREATOR`) refuses, because
 * those compare a person with a record and a tenant token is no person. An `X-Tenant-Id` header may only name the token's own tenant. On success the request carries
 * `tenantId` / `tenantRole` exactly as a membership would set them.
 */
export function assertTenantApiTokenRouteAccess(options: {
  context: IApiTokenContext;
  controllerClass: any;
  handler: any;
  request: any;
}): void {
  const { context, controllerClass, handler, request } = options;

  const handlerRoles = handler ? (Reflect.getMetadata('roles', handler) as string[] | undefined) : undefined;
  const classRoles = controllerClass
    ? (Reflect.getMetadata('roles', controllerClass) as string[] | undefined)
    : undefined;
  const roles = mergeRolesMetadata([handlerRoles, classRoles]);
  if (roles.includes(RoleEnum.S_NO_ONE)) {
    throw denied();
  }

  // Same precedence as CoreTenantGuard: method-level system roles decide over class-level ones.
  const systemCheckRoles = handlerRoles?.length ? handlerRoles : roles;
  const memberRole = getApiTokenTenantMemberRole();
  const openedBySystemRole = [RoleEnum.S_EVERYONE, RoleEnum.S_USER, RoleEnum.S_VERIFIED].some((role) =>
    systemCheckRoles.includes(role),
  );
  if (!openedBySystemRole) {
    const checkable = roles.filter((role) => !isSystemRole(role));
    // Only object-level system roles left (S_SELF, S_CREATOR, …): they need a person to compare with,
    // and a tenant token is nobody's "self" and created nothing. Skipping them would grant for ANY target.
    if (roles.length && !checkable.length) {
      throw denied();
    }
    if (checkable.length) {
      const tenantRoles = tenantSatisfiableRoles(checkable);
      if (!tenantRoles.length || !checkRoleAccess(tenantRoles, undefined, memberRole)) {
        throw denied();
      }
    }
  }

  assertTenantHeaderMatches(request, context.tenantId);

  if (request) {
    request.tenantId = context.tenantId;
    request.tenantRole = memberRole;
    request.isAdminBypass = false;
    request.tenantIds = undefined;
  }
}

/** A tenant header may only name the tenant a token is bound to. No header is fine — the binding applies. */
function assertTenantHeaderMatches(request: any, tenantId: string | undefined): void {
  const header = request?.headers?.[tenantHeaderName()];
  if (header !== undefined && (typeof header !== 'string' || header.trim() !== tenantId)) {
    throw denied();
  }
}

/**
 * Guard entry point, shared by RolesGuard, BetterAuthRolesGuard and CoreTenantGuard so the policy
 * cannot drift between them and holds whichever guard runs first or alone.
 *
 * Returns the kind of the token the request was authenticated with, or `undefined` when it does not
 * concern tokens at all:
 * - `TENANT` → fully decided here; the guard grants.
 * - `USER` → scopes and tenant restriction checked here; the guard continues with its ordinary checks,
 *   because a user token acts as its user.
 *
 * A request that carries a token credential but reached a guard without a token context — the
 * authentication middleware did not run — is refused with 401 rather than treated as anonymous.
 */
export function enforceApiTokenRoute(options: {
  controllerClass: any;
  handler: any;
  request: any;
}): ApiTokenKind | undefined {
  const { request } = options;
  if (!request) {
    return undefined;
  }
  const context = getApiTokenContext(request.user);
  if (!context) {
    if (!request.user && hasApiTokenCredential(request)) {
      throw new UnauthorizedException(ErrorCode.UNAUTHORIZED);
    }
    return undefined;
  }

  assertApiTokenScopes(context, options.handler, options.controllerClass);

  if (context.kind === ApiTokenKind.TENANT) {
    assertTenantApiTokenRouteAccess({ ...options, context });
    return ApiTokenKind.TENANT;
  }

  if (context.tenantId) {
    assertTenantHeaderMatches(request, context.tenantId);
  }
  return ApiTokenKind.USER;
}

// =====================================================================================================================
// Tenant integration for USER tokens (used by CoreTenantGuard)
// =====================================================================================================================

/** The one tenant a USER token is restricted to, if any. */
export function getApiTokenTenantRestriction(user: unknown): string | undefined {
  const context = getApiTokenContext(user);
  return context?.kind === ApiTokenKind.USER ? context.tenantId : undefined;
}

/**
 * The tenant role a request may act with, given the membership role of its user.
 *
 * For a USER token with `maxTenantRole` the lower of the two by hierarchy level; for everything else the
 * membership role unchanged. A membership role outside the hierarchy cannot be compared with a cap, so a
 * capped token gets NO tenant role then (`null`) — failing closed rather than guessing which is higher.
 */
export function capApiTokenTenantRole(user: unknown, membershipRole: string): null | string {
  const context = getApiTokenContext(user);
  if (context?.kind !== ApiTokenKind.USER || !context.maxTenantRole) {
    return membershipRole;
  }
  const levels = hierarchy();
  if (!(membershipRole in levels) || !(context.maxTenantRole in levels)) {
    return null;
  }
  return levels[membershipRole] <= levels[context.maxTenantRole] ? membershipRole : context.maxTenantRole;
}
