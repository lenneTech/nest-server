import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';

import { RoleEnum } from '../../common/enums/role.enum';
import { ConfigService } from '../../common/services/config.service';
import { CoreRedisService } from '../../common/services/core-redis.service';
import { InMemoryRateLimitStore, RateLimitStore, RedisRateLimitStore } from '../../common/services/rate-limit-store';
import { ErrorCode } from '../error-code/error-codes';
import { checkRoleAccess, getRoleHierarchy, resolveGlobalAndTenantRoles } from '../tenant/core-tenant.helpers';
import { CoreTenantService } from '../tenant/core-tenant.service';
import { API_TOKEN_MODEL_TOKEN, ApiTokenKind } from './core-api-token.constants';
import {
  assertApiTokenConfigIsUsable,
  attachApiTokenContext,
  checkApiTokenAssertionTiming,
  createTenantApiTokenPrincipal,
  decodeApiTokenAssertion,
  generateApiToken,
  generateApiTokenSigningKey,
  getApiTokenConfig,
  getApiTokenContext,
  getApiTokenManageRole,
  hashApiTokenSecret,
  IApiTokenContext,
  IApiTokenCredential,
  IResolvedApiTokenConfig,
  parseApiToken,
  resolveApiTokenEncryptionKey,
  safeEqualHex,
  verifyApiTokenAssertionSignature,
} from './core-api-token.helpers';
import { CoreApiTokenModel } from './core-api-token.model';
import { ApiTokenOwnerIdentity, setApiTokenRevoker } from './core-api-token.registry';

/** Fields a caller can never set through a create/update input. */
const PROTECTED_FIELDS = new Set([
  '_id',
  '__v',
  'createdAt',
  'createdBy',
  'id',
  'kind',
  'lastUsedAt',
  'publicId',
  'revokedAt',
  'secretHash',
  'signingKeyEncrypted',
  'tenant',
  'updatedAt',
  'updatedBy',
  'user',
]);

/** User fields never loaded onto a token-authenticated request user. */
const USER_SECRET_PROJECTION = {
  password: 0,
  passwordResetToken: 0,
  passwordResetTokenExpiresAt: 0,
  refreshTokens: 0,
  tempTokens: 0,
  verificationToken: 0,
};

/** Input for creating a USER token. Additional (project) fields are stored as given. */
export interface ICreateUserApiTokenInput {
  [projectField: string]: unknown;
  description?: string;
  /** Expiry (Date or ISO string); must lie in the future. Omit for no expiry. */
  expiresAt?: Date | null | string;
  /** Cap for the tenant role the token may act with (multi-tenancy only; a hierarchy role). */
  maxTenantRole?: null | string;
  name: string;
  /** Subset of `apiTokens.scopes`. Omit to receive the whole vocabulary. */
  scopes?: string[];
  /** Restrict the token to one tenant the user is an active member of (multi-tenancy only). */
  tenantId?: null | string;
}

/** Input for creating a TENANT token. Additional (project) fields are stored as given. */
export interface ICreateTenantApiTokenInput {
  [projectField: string]: unknown;
  description?: string;
  /** Expiry (Date or ISO string); must lie in the future. Omit for no expiry. */
  expiresAt?: Date | null | string;
  name: string;
  /** Subset of `apiTokens.scopes`; at least one. */
  scopes: string[];
}

/** Input for updating a token. Only the given fields change; `null` clears an optional one. */
export interface IUpdateApiTokenInput {
  [projectField: string]: unknown;
  description?: null | string;
  expiresAt?: Date | null | string;
  /** USER tokens only. */
  maxTenantRole?: null | string;
  name?: string;
  scopes?: string[];
  /** USER tokens only. */
  tenantId?: null | string;
}

/** A token as returned by the service — never with its hash or signing key. */
export type ApiTokenInfo = Omit<CoreApiTokenModel, 'secretHash' | 'securityCheck' | 'signingKeyEncrypted'> & {
  [projectField: string]: unknown;
};

/** Result of creating a token. `token` and `signingKey` exist only here — they are never shown again. */
export interface ICreatedApiToken {
  apiToken: ApiTokenInfo;
  /** For signed assertions (64 hex characters), see README → "Signed assertions". */
  signingKey: string;
  /** The credential itself: `Authorization: Bearer <token>` or `x-api-key: <token>`. */
  token: string;
}

/**
 * API tokens: authentication (used by `CoreApiTokenMiddleware`) and management.
 *
 * Management is split by owner:
 * - USER tokens — the user manages their own (`*UserToken*`),
 * - TENANT tokens — people holding `apiTokens.manageRole` in the tenant, or platform admins
 *   (`*TenantToken*`).
 * Every management method takes the acting user and checks the right itself, so a project controller
 * only forwards `@CurrentUser()` (and `@CurrentTenant()`). A request authenticated WITH a token is
 * always refused: tokens never manage tokens.
 *
 * Extend via the Module Inheritance Pattern and register the subclass with
 * `CoreModule.forRoot(env, { apiToken: { service } })`.
 */
@Injectable()
export class CoreApiTokenService implements OnModuleDestroy, OnModuleInit {
  protected readonly logger = new Logger(CoreApiTokenService.name);

  /** Last `lastUsedAt` write per token in this process. */
  protected readonly lastUsedWrites = new Map<string, number>();
  protected rateLimitStore?: RateLimitStore;
  private warnedAboutDevelopmentKey = false;
  private disposeRevoker?: () => void;

  /** Minimum interval between two `lastUsedAt` writes for the same token. */
  protected static readonly LAST_USED_INTERVAL_MS = 60_000;
  /** Size cap of the `lastUsedAt` throttle map. */
  protected static readonly LAST_USED_MAX_ENTRIES = 5000;

  constructor(
    @InjectModel(API_TOKEN_MODEL_TOKEN) protected readonly apiTokenModel: Model<CoreApiTokenModel>,
    @Optional() @InjectConnection() protected readonly connection?: Connection,
    @Optional() protected readonly tenantService?: CoreTenantService,
    @Optional() protected readonly redisService?: CoreRedisService,
  ) {}

  onModuleInit(): void {
    assertApiTokenConfigIsUsable();
    // Let the password-reset paths (Better-Auth hook, legacy resetPassword) revoke user tokens
    // without importing this optional module — see core-api-token.registry.ts.
    this.disposeRevoker = setApiTokenRevoker((identity) => this.revokeAllForOwner(identity));
    const config = getApiTokenConfig();
    if (config.enabled && config.scopes.length === 0) {
      this.logger.warn(
        'apiTokens is enabled but apiTokens.scopes is empty: no token can be created and no route can be opened ' +
          'to one. Declare the scopes your routes use, e.g. scopes: ["read", "upload"].',
      );
    }
  }

  onModuleDestroy(): void {
    this.disposeRevoker?.();
  }

  // ===================================================================================================================
  // Authentication
  // ===================================================================================================================

  /**
   * Resolve a credential to the request user, or `null` for anything that must be refused — unknown,
   * malformed, revoked, expired, wrong secret, bad signature, disabled kind, deleted owner. Never throws
   * for a bad credential, never logs one.
   *
   * - TENANT token → a principal (`createTenantApiTokenPrincipal`)
   * - USER token → the owning user, freshly loaded, without global roles
   * Both carry the token context (`getApiTokenContext`).
   */
  async authenticate(credential: IApiTokenCredential): Promise<null | object> {
    const config = getApiTokenConfig();
    if (!config.enabled) {
      return null;
    }

    if (credential.kind === 'token') {
      const parsed = parseApiToken(credential.value, config.prefix);
      if (!parsed) {
        return null;
      }
      const token = await this.findUsableToken(parsed.publicId, config);
      if (!token || !safeEqualHex(hashApiTokenSecret(parsed.secret), token.secretHash)) {
        return null;
      }
      return this.buildRequestUser(token);
    }

    const decoded = decodeApiTokenAssertion(credential.value, config.prefix);
    if (!decoded || checkApiTokenAssertionTiming(decoded.payload, config.maxAssertionLifetimeSeconds) !== 'ok') {
      return null;
    }
    const token = await this.findUsableToken(decoded.payload.tid, config);
    if (!token?.signingKeyEncrypted) {
      return null;
    }
    let signingKey: string;
    try {
      signingKey = this.decryptSigningKey(token.signingKeyEncrypted);
    } catch {
      // Logged inside decryptSigningKey without the value; a key mismatch refuses the request.
      return null;
    }
    if (!verifyApiTokenAssertionSignature(decoded.payloadSegment, decoded.signature, signingKey)) {
      return null;
    }
    return this.buildRequestUser(token, {
      claims: decoded.payload.claims,
      expiresAt: new Date(decoded.payload.exp * 1000),
      nonce: decoded.payload.nonce,
      subject: decoded.payload.sub,
    });
  }

  /**
   * Count one request against the token's limit. Returns `{ retryAfter }` once the limit is exceeded,
   * `undefined` otherwise (or when rate limiting is off). Shared across replicas with `redis`.
   */
  async consumeRateLimit(tokenId: string): Promise<undefined | { retryAfter: number }> {
    const { rateLimit } = getApiTokenConfig();
    if (!rateLimit) {
      return undefined;
    }
    const { count, resetIn } = await this.getRateLimitStore().hit(tokenId, rateLimit.windowSeconds);
    return count > rateLimit.max ? { retryAfter: Math.max(1, Math.ceil(resetIn)) } : undefined;
  }

  /** Record a use — at most once per minute and token in this process, never awaited by the request. */
  touchLastUsed(tokenId: string): void {
    const now = Date.now();
    const last = this.lastUsedWrites.get(tokenId);
    if (last !== undefined && now - last < CoreApiTokenService.LAST_USED_INTERVAL_MS) {
      return;
    }
    if (this.lastUsedWrites.size >= CoreApiTokenService.LAST_USED_MAX_ENTRIES) {
      this.lastUsedWrites.clear();
    }
    this.lastUsedWrites.set(tokenId, now);
    this.apiTokenModel
      .updateOne({ _id: tokenId }, { $set: { lastUsedAt: new Date(now) } }, { timestamps: false })
      .exec()
      .catch((error: Error) => this.logger.debug(`lastUsedAt update failed: ${error.message}`));
  }

  /** A token that may authenticate right now: known, not revoked, not expired, kind enabled. */
  protected async findUsableToken(
    publicId: string,
    config: IResolvedApiTokenConfig,
  ): Promise<CoreApiTokenModel | null> {
    const token = (await this.apiTokenModel
      .findOne({ publicId })
      .select('+secretHash +signingKeyEncrypted')
      .lean()
      .exec()) as (CoreApiTokenModel & { _id: Types.ObjectId }) | null;
    if (!token || token.revokedAt || (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now())) {
      return null;
    }
    if (
      token.kind === ApiTokenKind.TENANT ? !config.tenantTokens || !token.tenant : !config.userTokens || !token.user
    ) {
      return null;
    }
    return { ...token, id: token._id.toString() } as CoreApiTokenModel;
  }

  /** Build `request.user` for a usable token. `null` when the owner of a user token no longer exists. */
  protected async buildRequestUser(
    token: CoreApiTokenModel,
    assertion?: IApiTokenContext['assertion'],
  ): Promise<null | object> {
    const context: Omit<IApiTokenContext, 'kind'> = {
      assertion,
      maxTenantRole: token.maxTenantRole || undefined,
      name: token.name,
      publicId: token.publicId,
      scopes: token.scopes ?? [],
      tenantId: token.tenant || undefined,
      tokenId: token.id,
      userId: token.user || undefined,
    };

    if (token.kind === ApiTokenKind.TENANT) {
      return createTenantApiTokenPrincipal({ ...context, tenantId: token.tenant });
    }

    const user = await this.loadTokenUser(token.user);
    return user ? attachApiTokenContext(user, { ...context, kind: ApiTokenKind.USER }) : null;
  }

  /**
   * Load the owner of a USER token as a request user — the same `users` document Better-Auth and the
   * legacy JWT strategy resolve, so the token acts as exactly that person.
   *
   * Global roles (RoleEnum.ADMIN, `multiTenancy.globalOnlyRoles`) are REMOVED: a long-lived bearer
   * string must not carry platform authority, and without them there is no admin bypass across tenant
   * boundaries either. Secrets (password hash, reset/verification tokens) are never loaded.
   * `protected` so a project with a different user store can override it.
   */
  protected async loadTokenUser(userId: string): Promise<null | Record<string, any>> {
    if (!this.connection || !userId || !Types.ObjectId.isValid(userId)) {
      return null;
    }
    const doc = await this.connection
      .collection('users')
      .findOne({ _id: new Types.ObjectId(userId) }, { projection: USER_SECRET_PROJECTION });
    if (!doc) {
      return null;
    }

    const roles = (Array.isArray(doc.roles) ? doc.roles : []).filter(
      (role: unknown): role is string =>
        typeof role === 'string' && resolveGlobalAndTenantRoles([role]).global.length === 0,
    );
    return {
      ...doc,
      hasRole: (required: string | string[]): boolean =>
        (Array.isArray(required) ? required : [required]).some((role) => roles.includes(role)),
      id: doc._id.toString(),
      roles,
    };
  }

  protected getRateLimitStore(): RateLimitStore {
    if (!this.rateLimitStore) {
      this.rateLimitStore = this.redisService?.enabled
        ? new RedisRateLimitStore(this.redisService, 'api-token')
        : new InMemoryRateLimitStore(10_000);
    }
    return this.rateLimitStore;
  }

  // ===================================================================================================================
  // USER tokens — managed by their owner
  // ===================================================================================================================

  /** Create a USER token for the acting user. The plaintext token and signing key are returned only here. */
  async createUserToken(input: ICreateUserApiTokenInput, currentUser: any): Promise<ICreatedApiToken> {
    const config = this.requireKind(ApiTokenKind.USER);
    this.assertPerson(currentUser);

    const scopes = this.validateScopes(input?.scopes ?? config.scopes, config);
    const tenantId = await this.validateUserTokenTenant(input?.tenantId, currentUser, config);
    const maxTenantRole = this.validateMaxTenantRole(input?.maxTenantRole, config);

    return this.issue(
      {
        ...this.projectFields(input),
        description: this.validateDescription(input?.description),
        expiresAt: this.validateExpiry(input?.expiresAt),
        kind: ApiTokenKind.USER,
        maxTenantRole,
        name: this.validateName(input?.name),
        scopes,
        tenant: tenantId,
        user: String(currentUser.id),
      },
      currentUser,
    );
  }

  /** The acting user's own USER tokens. */
  async findUserTokens(currentUser: any): Promise<ApiTokenInfo[]> {
    this.requireKind(ApiTokenKind.USER);
    this.assertPerson(currentUser);
    return this.list({ kind: ApiTokenKind.USER, user: String(currentUser.id) });
  }

  /** Change one of the acting user's own USER tokens. */
  async updateUserToken(tokenId: string, input: IUpdateApiTokenInput, currentUser: any): Promise<ApiTokenInfo> {
    const config = this.requireKind(ApiTokenKind.USER);
    this.assertPerson(currentUser);
    const filter = this.userTokenFilter(tokenId, currentUser);
    const $set: Record<string, unknown> = this.commonUpdate(input, config);
    if (input?.tenantId !== undefined) {
      $set.tenant = await this.validateUserTokenTenant(input.tenantId, currentUser, config);
    }
    if (input?.maxTenantRole !== undefined) {
      $set.maxTenantRole = this.validateMaxTenantRole(input.maxTenantRole, config);
    }
    return this.applyUpdate(filter, $set, currentUser);
  }

  /** Revoke one of the acting user's own USER tokens (idempotent). */
  async revokeUserToken(tokenId: string, currentUser: any): Promise<ApiTokenInfo> {
    this.requireKind(ApiTokenKind.USER);
    this.assertPerson(currentUser);
    return this.applyRevoke(this.userTokenFilter(tokenId, currentUser), currentUser);
  }

  /** Delete one of the acting user's own USER tokens. */
  async deleteUserToken(tokenId: string, currentUser: any): Promise<ApiTokenInfo> {
    this.requireKind(ApiTokenKind.USER);
    this.assertPerson(currentUser);
    return this.applyDelete(this.userTokenFilter(tokenId, currentUser));
  }

  /**
   * Revoke every token of a user (system operation, no rights check) — e.g. after an account compromise
   * or when the user is blocked. Returns the number of tokens revoked.
   */
  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.apiTokenModel
      .updateMany(
        { kind: ApiTokenKind.USER, revokedAt: null, user: String(userId) },
        { $set: { revokedAt: new Date() } },
      )
      .exec();
    return result.modifiedCount ?? 0;
  }

  /**
   * Revoke every token of a user identified by `users` id, Better-Auth (IAM) id or email — what the
   * password-reset paths know. Resolved the way the Better-Auth user mapper resolves a user
   * (`email` or `iamId`). Returns the number of tokens revoked; `0` for an unknown user.
   */
  async revokeAllForOwner(identity: ApiTokenOwnerIdentity): Promise<number> {
    let userId = identity?.userId;
    if (!userId && this.connection && (identity?.email || identity?.iamId)) {
      const or: Record<string, string>[] = [];
      if (identity.email) or.push({ email: identity.email });
      if (identity.iamId) or.push({ iamId: identity.iamId });
      const doc = await this.connection.collection('users').findOne({ $or: or }, { projection: { _id: 1 } });
      userId = doc?._id?.toString();
    }
    return userId ? this.revokeAllForUser(userId) : 0;
  }

  /** Delete every token of a user (system operation, no rights check) — call it when deleting the user. */
  async deleteAllForUser(userId: string): Promise<number> {
    const result = await this.apiTokenModel.deleteMany({ kind: ApiTokenKind.USER, user: String(userId) }).exec();
    return result.deletedCount ?? 0;
  }

  // ===================================================================================================================
  // TENANT tokens — managed by the tenant's administrators
  // ===================================================================================================================

  /** Create a TENANT token. The plaintext token and signing key are returned only here. */
  async createTenantToken(
    tenantId: string,
    input: ICreateTenantApiTokenInput,
    currentUser: any,
  ): Promise<ICreatedApiToken> {
    const config = this.requireKind(ApiTokenKind.TENANT);
    await this.assertCanManageTenant(tenantId, currentUser, config);
    if (!input?.scopes?.length) {
      throw new BadRequestException('A tenant token needs at least one scope');
    }

    return this.issue(
      {
        ...this.projectFields(input),
        description: this.validateDescription(input.description),
        expiresAt: this.validateExpiry(input.expiresAt),
        kind: ApiTokenKind.TENANT,
        name: this.validateName(input.name),
        scopes: this.validateScopes(input.scopes, config),
        tenant: tenantId,
      },
      currentUser,
    );
  }

  /** The tenant's TENANT tokens. */
  async findTenantTokens(tenantId: string, currentUser: any): Promise<ApiTokenInfo[]> {
    const config = this.requireKind(ApiTokenKind.TENANT);
    await this.assertCanManageTenant(tenantId, currentUser, config);
    return this.list({ kind: ApiTokenKind.TENANT, tenant: tenantId });
  }

  /** Change a TENANT token of the tenant. */
  async updateTenantToken(
    tenantId: string,
    tokenId: string,
    input: IUpdateApiTokenInput,
    currentUser: any,
  ): Promise<ApiTokenInfo> {
    const config = this.requireKind(ApiTokenKind.TENANT);
    await this.assertCanManageTenant(tenantId, currentUser, config);
    if (input?.tenantId !== undefined || input?.maxTenantRole !== undefined) {
      throw new BadRequestException('tenantId and maxTenantRole apply to user tokens only');
    }
    const $set = this.commonUpdate(input, config);
    if (Array.isArray($set.scopes) && !$set.scopes.length) {
      throw new BadRequestException('A tenant token needs at least one scope');
    }
    return this.applyUpdate(this.tenantTokenFilter(tenantId, tokenId), $set, currentUser);
  }

  /** Revoke a TENANT token of the tenant (idempotent). */
  async revokeTenantToken(tenantId: string, tokenId: string, currentUser: any): Promise<ApiTokenInfo> {
    const config = this.requireKind(ApiTokenKind.TENANT);
    await this.assertCanManageTenant(tenantId, currentUser, config);
    return this.applyRevoke(this.tenantTokenFilter(tenantId, tokenId), currentUser);
  }

  /** Delete a TENANT token of the tenant. */
  async deleteTenantToken(tenantId: string, tokenId: string, currentUser: any): Promise<ApiTokenInfo> {
    const config = this.requireKind(ApiTokenKind.TENANT);
    await this.assertCanManageTenant(tenantId, currentUser, config);
    return this.applyDelete(this.tenantTokenFilter(tenantId, tokenId));
  }

  /**
   * Delete every token bound to a tenant — its TENANT tokens and the USER tokens restricted to it
   * (system operation, no rights check). Call it when deleting the tenant; the core has no tenant model
   * of its own to hook into. Returns the number of tokens deleted.
   */
  async deleteAllForTenant(tenantId: string): Promise<number> {
    if (!tenantId?.trim()) {
      throw new BadRequestException('tenantId must not be empty');
    }
    const result = await this.apiTokenModel.deleteMany({ tenant: tenantId }).exec();
    return result.deletedCount ?? 0;
  }

  /**
   * May the acting user manage the tenant's tokens? Platform admins may while `adminBypass` is on;
   * everyone else needs an ACTIVE membership whose role reaches `apiTokens.manageRole`.
   */
  async assertCanManageTenant(tenantId: string, currentUser: any, config = getApiTokenConfig()): Promise<void> {
    if (!tenantId?.trim()) {
      throw new BadRequestException('tenantId must not be empty');
    }
    this.assertPerson(currentUser);

    const adminBypass = ConfigService.configFastButReadOnly?.multiTenancy?.adminBypass !== false;
    if (adminBypass && Array.isArray(currentUser.roles) && currentUser.roles.includes(RoleEnum.ADMIN)) {
      return;
    }

    const membership = await this.tenantService?.getActiveMembership(tenantId, String(currentUser.id));
    if (!membership || !checkRoleAccess([getApiTokenManageRole(config)], undefined, membership.role)) {
      throw new ForbiddenException(ErrorCode.ACCESS_DENIED);
    }
  }

  // ===================================================================================================================
  // Signing key encryption (AES-256-GCM, same shape as AiCryptoService)
  // ===================================================================================================================

  /** Encrypt a signing key for storage: `"<iv>.<tag>.<ciphertext>"`, base64 each. */
  protected encryptSigningKey(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.getEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
  }

  /** Decrypt a stored signing key. Throws on a key mismatch or a corrupted value. */
  protected decryptSigningKey(stored: string): string {
    const [ivB64, tagB64, dataB64] = (stored ?? '').split('.');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.getEncryptionKey(), Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
    } catch (error) {
      this.logger.error('Signing key decryption failed — apiTokens.encryptionKey changed or value corrupted');
      throw new Error('Signing key decryption failed', { cause: error });
    }
  }

  /** The 32-byte AES key. `protected` so a project can source it from a KMS instead. */
  protected getEncryptionKey(): Buffer {
    const secret = resolveApiTokenEncryptionKey();
    if (!secret) {
      if (!this.warnedAboutDevelopmentKey) {
        this.warnedAboutDevelopmentKey = true;
        this.logger.warn(
          'No apiTokens.encryptionKey / SECRETS_ENCRYPTION_KEY set — signing keys are encrypted with an insecure ' +
            'development default. Never run this in production (the boot refuses it there).',
        );
      }
      return createHash('sha256').update('lt-nest-server-api-token-dev-only-insecure-default').digest();
    }
    return createHash('sha256').update(secret, 'utf8').digest();
  }

  // ===================================================================================================================
  // Internals
  // ===================================================================================================================

  protected requireKind(kind: ApiTokenKind): IResolvedApiTokenConfig {
    const config = getApiTokenConfig();
    if (kind === ApiTokenKind.USER ? !config.userTokens : !config.tenantTokens) {
      throw new BadRequestException(
        kind === ApiTokenKind.USER
          ? 'User tokens are not enabled (apiTokens.userTokens)'
          : 'Tenant tokens are not enabled (apiTokens.tenantTokens, requires multiTenancy)',
      );
    }
    return config;
  }

  /** A person — authenticated, and not through a token. Tokens never manage tokens. */
  protected assertPerson(currentUser: any): void {
    if (!currentUser?.id) {
      throw new UnauthorizedException(ErrorCode.UNAUTHORIZED);
    }
    if (getApiTokenContext(currentUser)) {
      throw new ForbiddenException(ErrorCode.ACCESS_DENIED);
    }
  }

  protected async issue(document: Record<string, unknown>, currentUser: any): Promise<ICreatedApiToken> {
    const config = getApiTokenConfig();
    const { publicId, secret, token } = generateApiToken(config.prefix);
    const signingKey = generateApiTokenSigningKey();
    const created = await this.apiTokenModel.create({
      ...document,
      createdBy: String(currentUser.id),
      publicId,
      revokedAt: null,
      secretHash: hashApiTokenSecret(secret),
      signingKeyEncrypted: this.encryptSigningKey(signingKey),
      updatedBy: String(currentUser.id),
    });
    return { apiToken: this.toInfo(created.toObject()), signingKey, token };
  }

  protected async list(filter: Record<string, unknown>): Promise<ApiTokenInfo[]> {
    const tokens = await this.apiTokenModel.find(filter).sort({ createdAt: -1 }).lean().exec();
    return tokens.map((token) => this.toInfo(token));
  }

  protected async applyUpdate(
    filter: Record<string, unknown>,
    $set: Record<string, unknown>,
    currentUser: any,
  ): Promise<ApiTokenInfo> {
    const updated = await this.apiTokenModel
      .findOneAndUpdate(filter, { $set: { ...$set, updatedBy: String(currentUser.id) } }, { returnDocument: 'after' })
      .lean()
      .exec();
    if (!updated) {
      throw new NotFoundException('API token not found');
    }
    return this.toInfo(updated);
  }

  protected async applyRevoke(filter: Record<string, unknown>, currentUser: any): Promise<ApiTokenInfo> {
    const revoked = await this.apiTokenModel
      .findOneAndUpdate(
        { ...filter, revokedAt: null },
        { $set: { revokedAt: new Date(), updatedBy: String(currentUser.id) } },
        { returnDocument: 'after' },
      )
      .lean()
      .exec();
    if (revoked) {
      return this.toInfo(revoked);
    }
    // Already revoked: answer with the current state rather than an error.
    const existing = await this.apiTokenModel.findOne(filter).lean().exec();
    if (!existing) {
      throw new NotFoundException('API token not found');
    }
    return this.toInfo(existing);
  }

  protected async applyDelete(filter: Record<string, unknown>): Promise<ApiTokenInfo> {
    const deleted = await this.apiTokenModel.findOneAndDelete(filter).lean().exec();
    if (!deleted) {
      throw new NotFoundException('API token not found');
    }
    return this.toInfo(deleted);
  }

  protected userTokenFilter(tokenId: string, currentUser: any): Record<string, unknown> {
    return { _id: this.objectId(tokenId), kind: ApiTokenKind.USER, user: String(currentUser.id) };
  }

  protected tenantTokenFilter(tenantId: string, tokenId: string): Record<string, unknown> {
    return { _id: this.objectId(tokenId), kind: ApiTokenKind.TENANT, tenant: tenantId };
  }

  /** A token id that is not an ObjectId is simply not found — never a 500 from a cast error. */
  protected objectId(tokenId: string): Types.ObjectId {
    if (typeof tokenId !== 'string' || !/^[0-9a-f]{24}$/i.test(tokenId)) {
      throw new NotFoundException('API token not found');
    }
    return new Types.ObjectId(tokenId);
  }

  protected commonUpdate(input: IUpdateApiTokenInput, config: IResolvedApiTokenConfig): Record<string, unknown> {
    const $set: Record<string, unknown> = { ...this.projectFields(input) };
    if (input?.name !== undefined) $set.name = this.validateName(input.name);
    if (input?.description !== undefined) $set.description = this.validateDescription(input.description);
    if (input?.scopes !== undefined) $set.scopes = this.validateScopes(input.scopes, config);
    if (input?.expiresAt !== undefined) $set.expiresAt = this.validateExpiry(input.expiresAt);
    return $set;
  }

  /**
   * Project-specific fields of an input: everything that is neither protected nor handled explicitly.
   *
   * Judged by the ROOT of a key: Mongoose casts a dotted key as a path, so `scopes.0` would write the
   * scope list around its validation and `tenant.x` would address a protected field.
   */
  protected projectFields(input: Record<string, unknown> | undefined): Record<string, unknown> {
    const handled = new Set(['description', 'expiresAt', 'maxTenantRole', 'name', 'scopes', 'tenantId']);
    return Object.fromEntries(
      Object.entries(input ?? {}).filter(([key]) => {
        const segments = key.split('.');
        return (
          !PROTECTED_FIELDS.has(segments[0]) &&
          !handled.has(segments[0]) &&
          !segments.some((segment) => segment.startsWith('$'))
        );
      }),
    );
  }

  protected validateName(name: unknown): string {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 200) {
      throw new BadRequestException('name must be 1-200 characters');
    }
    return name.trim();
  }

  protected validateDescription(description: unknown): null | string {
    if (description === undefined || description === null || description === '') {
      return null;
    }
    if (typeof description !== 'string' || description.length > 1000) {
      throw new BadRequestException('description must be a string of at most 1000 characters');
    }
    return description;
  }

  protected validateExpiry(expiresAt: unknown): Date | null {
    if (expiresAt === undefined || expiresAt === null || expiresAt === '') {
      return null;
    }
    const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt as string);
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
      throw new BadRequestException('expiresAt must be a valid date in the future');
    }
    return date;
  }

  protected validateScopes(scopes: unknown, config: IResolvedApiTokenConfig): string[] {
    if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) {
      throw new BadRequestException('scopes must be an array of strings');
    }
    const unique = [...new Set(scopes as string[])];
    if (!unique.length) {
      throw new BadRequestException('A token needs at least one scope');
    }
    const unknown = unique.filter((scope) => !config.scopes.includes(scope));
    if (unknown.length) {
      throw new BadRequestException(
        `Unknown scope(s) [${unknown.join(', ')}]; allowed: [${config.scopes.join(', ')}] (apiTokens.scopes)`,
      );
    }
    return unique;
  }

  /** A user token may only be restricted to a tenant its owner is an ACTIVE member of. */
  protected async validateUserTokenTenant(
    tenantId: unknown,
    currentUser: any,
    config: IResolvedApiTokenConfig,
  ): Promise<null | string> {
    if (tenantId === undefined || tenantId === null || tenantId === '') {
      return null;
    }
    if (!config.multiTenancy || typeof tenantId !== 'string') {
      throw new BadRequestException('tenantId requires multiTenancy and must be a string');
    }
    const membership = await this.tenantService?.getActiveMembership(tenantId, String(currentUser.id));
    if (!membership) {
      throw new ForbiddenException(ErrorCode.ACCESS_DENIED);
    }
    return tenantId;
  }

  /** The cap must be a hierarchy role — only those can be compared. */
  protected validateMaxTenantRole(role: unknown, config: IResolvedApiTokenConfig): null | string {
    if (role === undefined || role === null || role === '') {
      return null;
    }
    if (!config.multiTenancy || typeof role !== 'string' || !(role in getRoleHierarchy())) {
      throw new BadRequestException(
        `maxTenantRole must be a role of multiTenancy.roleHierarchy: [${Object.keys(getRoleHierarchy()).join(', ')}]`,
      );
    }
    return role;
  }

  /** Strip everything secret and normalise the id. */
  protected toInfo(document: Record<string, any>): ApiTokenInfo {
    const { __v, _id, secretHash: _secretHash, signingKeyEncrypted: _signingKeyEncrypted, ...rest } = document ?? {};
    return { ...rest, id: (_id ?? rest.id)?.toString() } as ApiTokenInfo;
  }
}
