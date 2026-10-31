import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
  Type,
  UnauthorizedException,
} from '@nestjs/common';
import { DiscoveryService, ModuleRef } from '@nestjs/core';

import { RoleEnum } from '../../common/enums/role.enum.js';
import { getStringIds } from '../../common/helpers/db.helper.js';
import {
  buildCorsConfig,
  isCookiesEnabled,
  isProductionLikeEnv,
  resolveServerUrls,
} from '../../common/helpers/cookies.helper.js';
import type { ISync } from '../../common/interfaces/server-options.interface.js';
import type { DataStore } from '../../common/persistence/data-store.interface.js';
import { InjectStore } from '../../common/persistence/inject-store.decorator.js';
import { getModelDescriptor } from '../../common/persistence/model-metadata.registry.js';
import { isDuplicateIdError } from '../../common/persistence/mongoose-data-store.js';
import { getPersistedModelOptions } from '../../common/persistence/persisted-model.decorator.js';
import { getStoreToken } from '../../common/persistence/persistence.tokens.js';
import { isSyncId, VersionConflictError } from '../../common/persistence/policies/sync.policy.js';
import { resolveTenantScope } from '../../common/persistence/policies/tenant.policy.js';
import { DuplicateKeyError, QueryCastError, UnsupportedQueryError } from '../../common/persistence/sql/sql-errors.js';
import {
  getSyncAccessListener,
  setSyncAccessListener,
  type SyncAccessListener,
  type SyncRecordMove,
} from '../../common/persistence/sync-access.registry.js';
import {
  type SyncConflictStrategy,
  type SyncIdFormat,
  type SyncOperationRoles,
  SYNC_CLOCK_FIELD,
  SYNC_SEQUENCE_FIELD,
} from '../../common/persistence/sync-model.js';
import { MapAndValidatePipe } from '../../common/pipes/map-and-validate.pipe.js';
import { ConfigService } from '../../common/services/config.service.js';
import { CoreRedisService } from '../../common/services/core-redis.service.js';
import { CrudService } from '../../common/services/crud.service.js';
import { InMemoryRateLimitStore, RateLimitStore, RedisRateLimitStore } from '../../common/services/rate-limit-store.js';
import { RequestContext } from '../../common/services/request-context.service.js';
import { ErrorCode } from '../error-code/error-codes.js';
import {
  SYNC_CLAIM_TIMEOUT_MS,
  SYNC_DEFAULTS,
  SYNC_MUTATION_MODEL,
  SYNC_PULL_LIMIT_CEILING,
  SYNC_REAPPLY_ATTEMPTS,
  SYNC_STATE_MODEL,
} from './core-sync.constants.js';
import {
  decodeSyncCursor,
  deriveCursorKey,
  encodeSyncCursor,
  stableHash,
  type SyncCursorPosition,
  type SyncCursorState,
} from './core-sync-cursor.js';
import { getSyncFieldStrategies, getSyncServiceOptions, type SyncFieldStrategy } from './core-sync.decorators.js';
import { CoreSyncMutationStore } from './core-sync-mutation.store.js';
import { CoreSyncStateStore } from './core-sync-state.store.js';
import type {
  ISyncConflictContext,
  ISyncPullResult,
  ISyncPushItem,
  ISyncPushResult,
  ISyncRecord,
  SyncConflictResolution,
  SyncRejectCode,
  SyncResyncReason,
} from './interfaces/core-sync.interfaces.js';

/**
 * 410 Gone with `{ code: 'SYNC_RESYNC_REQUIRED', reason }` (protocol §8). `CoreSyncController` writes this body itself,
 * so it reaches the client in the protocol's shape whatever exception filter the project registered.
 */
export class SyncResyncRequiredException extends HttpException {
  constructor(readonly reason: SyncResyncReason) {
    super(
      { code: 'SYNC_RESYNC_REQUIRED', message: ErrorCode.SYNC_RESYNC_REQUIRED, reason, statusCode: HttpStatus.GONE },
      HttpStatus.GONE,
    );
  }
}

/** A model offered under `/sync`, resolved at bootstrap from its `@SyncService()` and `@PersistedModel({ sync })` */
export interface SyncModelRegistration {
  createInput: Type<any>;
  fieldStrategies: Readonly<Record<string, SyncFieldStrategy>>;
  idFormat: SyncIdFormat;
  model: Type<any>;
  /** The registered model name — also its name in the path */
  name: string;
  order: 'clock' | 'seq';
  /** Operation roles; an operation the model declares none for is open to ADMIN only */
  roles: Readonly<Required<SyncOperationRoles>>;
  scope: readonly string[];
  service: CrudService<any>;
  store: DataStore<any>;
  strategy: SyncConflictStrategy;
  tenantScoped: boolean;
  updateInput: Type<any>;
}

/** What one pull or push sees of the caller's access: compared with what the cursor was issued under */
interface SyncAccessState {
  epochs: string;
  fingerprint: string;
  user: string;
}

const ADMIN_ONLY: readonly string[] = Object.freeze([RoleEnum.ADMIN]);
const OPERATIONS = ['create', 'delete', 'pull', 'update'] as const;
const MAX_MUTATION_ID_LENGTH = 128;
const MAX_ID_LENGTH = 64;
/** Fields of a stored record that are never part of `data` in a pull (protocol §5.2) */
const SYSTEM_RECORD_FIELDS = new Set([
  '__v',
  '_id',
  'deletedAt',
  'id',
  'updatedAt',
  'version',
  SYNC_CLOCK_FIELD,
  SYNC_SEQUENCE_FIELD,
]);

/**
 * Offline sync (protocol `docs/offline-sync-protocol.md`, plan `.claude/plans/offline-sync/PLAN.md`): pull in pages
 * along the store's change order, push item by item with idempotency, conflict strategies and client ids, resync when a
 * cursor cannot be continued consistently.
 *
 * Every read and write goes through the model's own CrudService — its `process()` pipeline (operation roles, input
 * `@Restricted`, output filtering), `securityCheck()` and the tenant policy, with row-level security on PostgreSQL.
 * There is no lean path: the module never touches `native()` or `raw()` and never asks for the database's name; what
 * differs between databases it reads from `store.capabilities`.
 *
 * Extend it (`CoreModule.forRoot(env, { sync: { service } })`) to change a decision — every step is `protected`.
 */
@Injectable()
export class CoreSyncService implements OnApplicationBootstrap, OnModuleDestroy, SyncAccessListener {
  protected readonly logger = new Logger(CoreSyncService.name);
  protected readonly models = new Map<string, SyncModelRegistration>();
  protected readonly mutationStore: CoreSyncMutationStore;
  protected readonly stateStore: CoreSyncStateStore;
  protected cursorKey?: Buffer;
  protected rateLimitStore?: RateLimitStore;

  constructor(
    @InjectStore(SYNC_MUTATION_MODEL) mutations: DataStore<any>,
    @InjectStore(SYNC_STATE_MODEL) states: DataStore<any>,
    protected readonly discoveryService: DiscoveryService,
    protected readonly moduleRef: ModuleRef,
    @Optional() protected readonly redisService?: CoreRedisService,
  ) {
    const days = positiveNumber(this.config.retention?.mutationsDays, SYNC_DEFAULTS.mutationsDays);
    this.mutationStore = new CoreSyncMutationStore(mutations, {
      claimTimeoutMs: SYNC_CLAIM_TIMEOUT_MS,
      retentionMs: days * 86_400_000,
    });
    this.stateStore = new CoreSyncStateStore(states);
  }

  /** The `sync` configuration (an object; `true` reads as `{}`) */
  protected get config(): ISync {
    const value = ConfigService.configFastButReadOnly?.sync;
    return value && typeof value === 'object' ? value : {};
  }

  // ===================================================================================================================
  // Bootstrap
  // ===================================================================================================================

  async onApplicationBootstrap(): Promise<void> {
    this.cursorKey = deriveCursorKey(this.resolveCursorSecret());
    for (const registration of this.discoverModels()) {
      if (this.models.has(registration.name)) {
        throw new Error(`Sync: two services declare @SyncService() for the model "${registration.name}"`);
      }
      this.models.set(registration.name, registration);
    }
    setSyncAccessListener(this);
    if (this.models.size) {
      this.logger.log(`Offline sync for ${[...this.models.keys()].join(', ')}`);
    } else {
      this.logger.warn('Offline sync is configured, but no service declares @SyncService() — no model is offered');
    }
  }

  onModuleDestroy(): void {
    if (getSyncAccessListener() === this) {
      setSyncAccessListener(undefined);
    }
  }

  /** The registered models, by name */
  getModels(): ReadonlyMap<string, SyncModelRegistration> {
    return this.models;
  }

  /**
   * The cursor secret: `sync.cursorSecret`, else `SECRETS_ENCRYPTION_KEY`. Refuses to start without one in production
   * and staging — a known key would let anybody forge cursors; elsewhere a development default is used, with a warning.
   */
  protected resolveCursorSecret(): string {
    const secret = this.config.cursorSecret || process.env.SECRETS_ENCRYPTION_KEY;
    if (secret) {
      return secret;
    }
    const env = ConfigService.configFastButReadOnly?.env;
    if (isProductionLikeEnv(env)) {
      throw new Error(
        `Sync: no sync.cursorSecret / SECRETS_ENCRYPTION_KEY set in "${env}" — pull cursors would be signed with a ` +
          'known key',
      );
    }
    this.logger.warn(
      'No sync.cursorSecret / SECRETS_ENCRYPTION_KEY set — pull cursors are signed with an insecure development ' +
        'default. Never run this in production (the boot refuses it there).',
    );
    return 'lt-nest-server-sync-cursor-dev-only-insecure-default';
  }

  /** Every provider carrying `@SyncService()`, checked and resolved */
  protected discoverModels(): SyncModelRegistration[] {
    const seen = new Set<unknown>();
    const registrations: SyncModelRegistration[] = [];
    for (const wrapper of this.discoveryService.getProviders()) {
      const instance = wrapper.instance;
      const options = wrapper.metatype ? getSyncServiceOptions(wrapper.metatype as Function) : undefined;
      if (!options || !instance || seen.has(instance)) {
        continue;
      }
      seen.add(instance);
      registrations.push(this.resolveRegistration(instance, options));
    }
    return registrations;
  }

  protected resolveRegistration(
    service: unknown,
    options: NonNullable<ReturnType<typeof getSyncServiceOptions>>,
  ): SyncModelRegistration {
    const name = options.modelName ?? options.model?.name;
    const label = `@SyncService() on ${(service as object)?.constructor?.name}`;
    if (!(service instanceof CrudService)) {
      throw new Error(`Sync: ${label} — the service must extend CrudService`);
    }
    if (!name || !options.createInput || !options.updateInput) {
      throw new Error(`Sync: ${label} needs model, createInput and updateInput`);
    }
    let store: DataStore<any>;
    try {
      store = this.moduleRef.get(getStoreToken(name), { strict: false });
    } catch {
      throw new Error(`Sync: ${label} — the model "${name}" is not registered with CorePersistenceModule.forFeature()`);
    }
    const order = store?.capabilities?.changeOrder;
    if (!order) {
      throw new Error(`Sync: ${label} — the model "${name}" is not synchronized (@PersistedModel({ sync }))`);
    }
    if (order === 'clock' && typeof store.changeClock !== 'function') {
      throw new Error(`Sync: the store of "${name}" orders changes by clock but offers no changeClock()`);
    }
    const declared = getPersistedModelOptions(options.model)?.sync;
    const declaration = declared && typeof declared === 'object' ? declared : {};
    const strategy = declaration.strategy ?? 'reject';
    if (strategy === 'custom' && typeof (service as any).resolveSyncConflict !== 'function') {
      throw new Error(
        `Sync: "${name}" declares strategy 'custom', but ${service.constructor.name} has no resolveSyncConflict()`,
      );
    }
    const missing = OPERATIONS.filter((operation) => !declaration.roles?.[operation]?.length);
    if (missing.length) {
      this.logger.warn(
        `Sync: "${name}" declares no sync roles for ${missing.join(', ')} — open to ADMIN only. Declare them in ` +
          '@PersistedModel({ sync: { roles } })',
      );
    }
    const roles = Object.freeze(
      Object.fromEntries(
        OPERATIONS.map((operation) => [operation, Object.freeze([...(declaration.roles?.[operation] ?? ADMIN_ONLY)])]),
      ),
    ) as unknown as Readonly<Required<SyncOperationRoles>>;
    const descriptor = getModelDescriptor(name);
    return {
      createInput: options.createInput,
      fieldStrategies: Object.freeze(getSyncFieldStrategies(options.model)),
      idFormat: store.capabilities.idType,
      model: options.model,
      name,
      order,
      roles,
      scope: descriptor?.sync?.scope ?? [],
      service,
      store,
      strategy,
      tenantScoped: !!descriptor?.tenantScoped,
      updateInput: options.updateInput,
    };
  }

  /** The registration of a model, or 404 — an unknown name and a model not offered for sync answer the same */
  protected registration(model: string): SyncModelRegistration {
    const registration = typeof model === 'string' ? this.models.get(model) : undefined;
    if (!registration) {
      throw new NotFoundException(ErrorCode.SYNC_MODEL_NOT_FOUND);
    }
    return registration;
  }

  // ===================================================================================================================
  // Pull (protocol §5)
  // ===================================================================================================================

  /**
   * One page of changes after the cursor, in the store's change order — tombstones included, through the model's
   * CrudService with the pull roles, every record through `securityCheck()`. A record the caller may not see still moves
   * the cursor on.
   */
  async pull(model: string, query: { cursor?: unknown; limit?: unknown }, currentUser: any): Promise<ISyncPullResult> {
    const registration = this.registration(model);
    await registration.service.checkRights(undefined, currentUser, { roles: [...registration.roles.pull] });
    const limit = this.pullLimit(query.limit);
    const access = await this.accessState(registration, currentUser);
    const state =
      query.cursor === undefined || query.cursor === ''
        ? undefined
        : await this.continuedCursor(registration, query.cursor, access);
    const clock = await this.readClock(registration);

    const runStart = state?.runStart ?? clock.now;
    const since = state ? state.since : runStart;
    const position = state?.position ?? initialPosition(registration.order);
    const rows = await this.readPositions(registration, position, limit + 1);

    const page = rows.slice(0, limit);
    const contents = await this.readContents(
      registration,
      page.map((row) => String(row.id)),
      currentUser,
    );
    const maxBytes = positiveNumber(this.config.pull?.maxBytes, SYNC_DEFAULTS.maxBytes);
    const items: ISyncRecord[] = [];
    let bytes = 2;
    let consumed = 0;
    let last = position;
    for (const raw of page) {
      const record = contents.get(String(raw.id));
      // Not in the content read: hidden from the caller (roles, securityCheck), or removed in between
      const item = record ? this.toSyncRecord(registration, record, raw, currentUser) : undefined;
      if (item) {
        const size = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (items.length && bytes + size > maxBytes) {
          break;
        }
        items.push(item);
        bytes += size;
      }
      consumed++;
      last = this.positionOf(registration, raw);
    }
    const hasMore = consumed < rows.length;
    const next: Omit<SyncCursorState, 'epochs' | 'fingerprint' | 'model' | 'user'> = hasMore
      ? { position: last, runStart, since }
      : // The run ended: the next one starts from here (SQL), or from W below this run's start (clock, plan §3.4)
        {
          position: registration.order === 'seq' ? last : { at: runStart - clock.windowMs, id: '' },
          since: runStart,
        };
    const cursor = encodeSyncCursor(
      { ...next, epochs: access.epochs, fingerprint: access.fingerprint, model: registration.name, user: access.user },
      this.cursorKey,
    );
    return { cursor, hasMore, items };
  }

  /** The cursor's state, checked against the model, the caller, the access and the horizon — or a 410 resync */
  protected async continuedCursor(
    registration: SyncModelRegistration,
    cursor: unknown,
    access: SyncAccessState,
  ): Promise<SyncCursorState> {
    const state = decodeSyncCursor(cursor, this.cursorKey);
    if (
      !state ||
      state.model !== registration.name ||
      state.user !== access.user ||
      'seq' in state.position !== (registration.order === 'seq')
    ) {
      // Another model, another user, another change order (a model moved between databases), tampered with
      this.resync('invalid');
    }
    if (state.fingerprint !== access.fingerprint || state.epochs !== access.epochs) {
      this.resync('access');
    }
    const horizon = await this.stateStore.horizon(registration.name);
    if (horizon && state.since < horizon.getTime()) {
      this.resync('horizon');
    }
    return state;
  }

  /** The pull's `limit`: absent → the default; otherwise an integer from 1 to the configured maximum */
  protected pullLimit(value: unknown): number {
    const max = Math.min(positiveNumber(this.config.pull?.maxLimit, SYNC_DEFAULTS.maxLimit), SYNC_PULL_LIMIT_CEILING);
    const fallback = Math.min(positiveNumber(this.config.pull?.defaultLimit, SYNC_DEFAULTS.pullLimit), max);
    if (value === undefined || value === '') {
      return fallback;
    }
    const limit =
      typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > max) {
      throw new BadRequestException(`${ErrorCode.SYNC_INVALID_REQUEST}: limit must be an integer from 1 to ${max}`);
    }
    return limit;
  }

  /** The database's clock and W (clock order), or this process's clock (sequence order: only the horizon reads it) */
  protected async readClock(registration: SyncModelRegistration): Promise<{ now: number; windowMs: number }> {
    if (registration.order !== 'clock') {
      return { now: Date.now(), windowMs: 0 };
    }
    const clock = await this.storeCall(() => registration.store.changeClock());
    const configured = this.config.pull?.windowSeconds;
    const windowMs = typeof configured === 'number' && configured >= 0 ? configured * 1000 : clock.windowMs;
    return { now: clock.now.getTime(), windowMs };
  }

  /**
   * The next records after `position` in change order, tombstones included — their system fields only (id, version,
   * deletion, update time, change position, tenant), read through the store: the same tenant policy and row-level
   * security as every read. This read decides the page and the cursor; the content follows in a second read
   * (`readContents()`). In that order a version or position is never newer than the content it labels — a record changed
   * between the two reads is labelled with its older version and comes again at its new position, where reading the
   * positions second let the cursor jump past the records after it.
   *
   * Without `X-Tenant-Id` a tenant-scoped model is read once per tenant of the caller, with the tenant as an equality,
   * and the pages are merged by position: the change-order index is led by the tenant, and only an equality lets it
   * deliver the order — a membership list (`tenantId IN (…)`) leaves every page to read and sort the whole remaining
   * scope on PostgreSQL, MySQL and MariaDB.
   */
  protected async readPositions(
    registration: SyncModelRegistration,
    position: SyncCursorPosition,
    count: number,
  ): Promise<any[]> {
    let where: Record<string, unknown>;
    let sort: Record<string, 1>;
    if ('seq' in position) {
      where = { [SYNC_SEQUENCE_FIELD]: { $gt: position.seq } };
      sort = { [SYNC_SEQUENCE_FIELD]: 1 };
    } else {
      const at = new Date(position.at);
      where = position.id
        ? { $or: [{ [SYNC_CLOCK_FIELD]: { $gt: at } }, { id: { $gt: position.id }, [SYNC_CLOCK_FIELD]: at }] }
        : { [SYNC_CLOCK_FIELD]: { $gte: at } };
      sort = { [SYNC_CLOCK_FIELD]: 1, id: 1 };
    }
    const options = { includeTombstones: true, limit: count, select: this.systemFields(registration), sort };
    const scope = registration.tenantScoped ? resolveTenantScope() : undefined;
    const tenants = scope?.kind === 'tenants' ? [...new Set(scope.tenantIds.map(String))] : [];
    if (!tenants.length) {
      return this.storeCall(() => registration.store.find(where, options));
    }
    const pages = await Promise.all(
      tenants.map((tenantId) => this.storeCall(() => registration.store.find({ ...where, tenantId }, options))),
    );
    return pages
      .flat()
      .sort((a, b) => this.comparePositions(registration, a, b))
      .slice(0, count);
  }

  /** The change order of two records' system fields: the sequence, or the server stamp and then the id */
  protected comparePositions(registration: SyncModelRegistration, a: any, b: any): number {
    if (registration.order === 'seq') {
      return Number(a?.[SYNC_SEQUENCE_FIELD]) - Number(b?.[SYNC_SEQUENCE_FIELD]);
    }
    const at = new Date(a?.[SYNC_CLOCK_FIELD]).getTime() - new Date(b?.[SYNC_CLOCK_FIELD]).getTime();
    if (at) {
      return at;
    }
    // ObjectId hex and canonical UUID strings sort like their bytes, as MongoDB sorts `_id`
    const left = String(a?.id);
    const right = String(b?.id);
    return left < right ? -1 : left > right ? 1 : 0;
  }

  /**
   * The content of the given records as the caller may see it, through the model's CrudService with the pull roles
   * (`process()`, field restrictions, tenant policy, RLS); keyed by id. A record the caller may not see is not in it.
   */
  protected async readContents(
    registration: SyncModelRegistration,
    ids: string[],
    currentUser: any,
  ): Promise<Map<string, any>> {
    const result = new Map<string, any>();
    if (!ids.length) {
      return result;
    }
    const records = await this.storeCall(() =>
      registration.service.find(
        { filterQuery: { _id: { $in: ids } } },
        { currentUser, includeTombstones: true, roles: [...registration.roles.pull] },
      ),
    );
    for (const record of Array.isArray(records) ? records : []) {
      result.set(String(recordId(record)), record);
    }
    return result;
  }

  /**
   * The system fields of records — version, deletion, update time, change position, tenant — read through the store
   * (the same tenant policy and row-level security as the CrudService read). They come from here rather than from the
   * CrudService output, because a model restricted at class level (`@Restricted(RoleEnum.ADMIN)`, the usual pattern)
   * strips every field it does not declare from that output, and no model declares these: they are the store's.
   */
  protected async readSystemFields(registration: SyncModelRegistration, ids: string[]): Promise<Map<string, any>> {
    const result = new Map<string, any>();
    if (!ids.length) {
      return result;
    }
    const rows = await this.storeCall(() =>
      registration.store.find(
        { id: { $in: ids } },
        { includeTombstones: true, select: this.systemFields(registration) },
      ),
    );
    for (const row of rows) {
      result.set(String(row.id), row);
    }
    return result;
  }

  /** The system fields a sync record is built from; the id is always returned */
  protected systemFields(registration: SyncModelRegistration): string[] {
    const fields = getModelDescriptor(registration.name)?.fields ?? {};
    return [
      'deletedAt',
      'version',
      registration.order === 'seq' ? SYNC_SEQUENCE_FIELD : SYNC_CLOCK_FIELD,
      ...['tenantId', 'updatedAt'].filter((field) => field in fields),
    ];
  }

  /** Where a record sits in the change order (from its system fields, which `securityCheck()` cannot clear) */
  protected positionOf(registration: SyncModelRegistration, raw: any): SyncCursorPosition {
    if (registration.order === 'seq') {
      return { seq: Number(raw?.[SYNC_SEQUENCE_FIELD]) };
    }
    return { at: new Date(raw?.[SYNC_CLOCK_FIELD]).getTime(), id: String(raw?.id) };
  }

  /**
   * A record as the protocol carries it, after the model's `securityCheck()` — `undefined` when the check hides it.
   * `record` is the CrudService output (the content the caller may see), `raw` its system fields. A tombstone keeps
   * only its id, version, times, `tenantId` and the scope fields the caller may see (protocol §2).
   */
  protected toSyncRecord(
    registration: SyncModelRegistration,
    record: any,
    raw: any,
    currentUser: any,
  ): ISyncRecord | undefined {
    if (!record || !raw) {
      return undefined;
    }
    const checked = typeof record.securityCheck === 'function' ? record.securityCheck(currentUser, false) : record;
    if (!checked) {
      return undefined;
    }
    const plain: Record<string, any> = { ...checked };
    const base: ISyncRecord = {
      deletedAt: raw.deletedAt ? new Date(raw.deletedAt) : null,
      id: String(raw.id),
      ...(raw.updatedAt ? { updatedAt: new Date(raw.updatedAt) } : {}),
      version: Number(raw.version),
    };
    if (base.deletedAt) {
      if (registration.tenantScoped && raw.tenantId !== undefined && raw.tenantId !== null) {
        base.tenantId = String(getStringIds(raw.tenantId));
      }
      for (const field of registration.scope) {
        if (plain[field] !== undefined) {
          base[field] = getStringIds(plain[field]);
        }
      }
      return base;
    }
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(plain)) {
      if (!SYSTEM_RECORD_FIELDS.has(key) && value !== undefined && typeof value !== 'function') {
        data[key] = value;
      }
    }
    return { ...base, data };
  }

  /**
   * What the caller's access looks like now: a fingerprint of everything that decides which records the caller sees
   * (user, tenant scope, global roles, membership role, verification state) and a hash of the access epochs of that
   * scope. A cursor issued under other values answers 410 `access` (plan §3.8).
   */
  protected async accessState(registration: SyncModelRegistration, currentUser: any): Promise<SyncAccessState> {
    const context = RequestContext.get();
    const user = String(getStringIds(currentUser?.id));
    const scope = context?.tenantId
      ? [context.tenantId]
      : context?.tenantIds
        ? [...context.tenantIds].map(String).sort()
        : context?.isAdminBypass
          ? ['*']
          : [];
    const fingerprint = stableHash([
      user,
      scope,
      [...(Array.isArray(currentUser?.roles) ? currentUser.roles : [])].map(String).sort(),
      context?.tenantRole ?? null,
      !!(currentUser?.verified || currentUser?.verifiedAt || currentUser?.emailVerified),
    ]);
    const tenants = registration.tenantScoped && scope.length ? scope : ['-'];
    const keys = tenants.flatMap((tenant) => [
      CoreSyncStateStore.tenantEpochKey(registration.name, tenant),
      ...(registration.scope.length ? [CoreSyncStateStore.userEpochKey(registration.name, tenant, user)] : []),
    ]);
    const epochs = await this.storeCall(() => this.stateStore.epochs(keys));
    return { epochs: stableHash([...epochs.entries()].sort(([a], [b]) => a.localeCompare(b))), fingerprint, user };
  }

  // ===================================================================================================================
  // Push (protocol §6)
  // ===================================================================================================================

  /**
   * Apply the pushed items in the order sent, each on its own (protocol §6.3) — one result per item. A malformed body
   * is refused as a whole before any item is applied.
   */
  async push(model: string, body: unknown, currentUser: any): Promise<{ results: ISyncPushResult[] }> {
    const registration = this.registration(model);
    const items = this.pushItems(body);
    const results: ISyncPushResult[] = [];
    for (const item of items) {
      results.push(await this.pushItem(registration, item, currentUser));
    }
    return { results };
  }

  /** The items of a push body, checked for shape; anything malformed answers 400 for the whole request */
  protected pushItems(body: unknown): ISyncPushItem[] {
    const invalid = (reason: string) => new BadRequestException(`${ErrorCode.SYNC_INVALID_REQUEST}: ${reason}`);
    const items = (body as { items?: unknown })?.items;
    if (!Array.isArray(items)) {
      throw invalid('the body must be { "items": [ … ] }');
    }
    const max = positiveNumber(this.config.push?.maxItems, SYNC_DEFAULTS.maxItems);
    if (items.length > max) {
      throw invalid(`at most ${max} items per push`);
    }
    return items.map((item, index) => {
      const at = `items[${index}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw invalid(`${at} must be an object`);
      }
      const { baseVersion, data, fields, id, mutationId, op } = item as Record<string, unknown>;
      if (typeof mutationId !== 'string' || !mutationId || mutationId.length > MAX_MUTATION_ID_LENGTH) {
        throw invalid(`${at}.mutationId must be a string of 1 to ${MAX_MUTATION_ID_LENGTH} characters`);
      }
      if (op !== 'upsert' && op !== 'delete') {
        throw invalid(`${at}.op must be "upsert" or "delete"`);
      }
      if (typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH) {
        throw invalid(`${at}.id must be a string of 1 to ${MAX_ID_LENGTH} characters`);
      }
      if (baseVersion !== undefined && (!Number.isInteger(baseVersion) || (baseVersion as number) < 1)) {
        throw invalid(`${at}.baseVersion must be a positive integer`);
      }
      if (op === 'upsert' && (!data || typeof data !== 'object' || Array.isArray(data))) {
        throw invalid(`${at}.data must be an object`);
      }
      if (fields !== undefined && (!Array.isArray(fields) || fields.some((field) => typeof field !== 'string'))) {
        throw invalid(`${at}.fields must be a list of field names`);
      }
      return {
        ...(baseVersion === undefined ? {} : { baseVersion: baseVersion as number }),
        ...(op === 'upsert' ? { data: data as Record<string, unknown> } : {}),
        ...(fields === undefined ? {} : { fields: fields as string[] }),
        id,
        mutationId,
        op,
      };
    });
  }

  /**
   * One item: claim its mutation, apply it, record the outcome. A repeat is answered with the recorded outcome, a
   * claim still being written with `retry`; a transient failure releases the claim so the client's retry is written.
   */
  protected async pushItem(
    registration: SyncModelRegistration,
    item: ISyncPushItem,
    currentUser: any,
  ): Promise<ISyncPushResult> {
    if (!isSyncId(item.id, registration.idFormat)) {
      return reply(item, 'rejected', { code: 'INVALID_ID' });
    }
    const key = CoreSyncMutationStore.key(
      registration.name,
      String(getStringIds(currentUser?.id)),
      item.id,
      item.mutationId,
    );
    let claim: Awaited<ReturnType<CoreSyncMutationStore['claim']>>;
    try {
      claim = await this.mutationStore.claim(key);
    } catch (error) {
      this.logger.warn(`Sync: mutation store unavailable (${(error as Error)?.message ?? error})`);
      return reply(item, 'retry');
    }
    if (claim.kind === 'busy') {
      return reply(item, 'retry');
    }
    if (claim.kind === 'done') {
      return this.repeatedResult(registration, item, claim.outcome, currentUser);
    }

    let result: ISyncPushResult;
    try {
      result = await this.applyItem(registration, item, currentUser);
    } catch (error) {
      this.logger.warn(
        `Sync: ${registration.name} ${item.id} not applied, client retries (${(error as Error)?.message ?? error})`,
      );
      result = reply(item, 'retry');
    }
    try {
      if (result.status === 'retry') {
        await this.mutationStore.release(key);
      } else {
        await this.mutationStore.complete(key, { code: result.code, status: result.status, version: result.version });
      }
    } catch (error) {
      // The write happened; a repeat finds the claim and, after the claim timeout, meets its own effect
      this.logger.warn(`Sync: outcome of a mutation not recorded (${(error as Error)?.message ?? error})`);
    }
    return result;
  }

  /** A recognised repeat: the recorded status, with the record as the caller may see it now where the status has one */
  protected async repeatedResult(
    registration: SyncModelRegistration,
    item: ISyncPushItem,
    outcome: { code?: string; status: string; version?: number },
    currentUser: any,
  ): Promise<ISyncPushResult> {
    const result = reply(item, outcome.status as ISyncPushResult['status'], {
      ...(outcome.code ? { code: outcome.code as SyncRejectCode } : {}),
      ...(outcome.version === undefined ? {} : { version: outcome.version }),
    });
    if (outcome.status === 'conflict' || outcome.status === 'merged') {
      const record = await this.findVisible(registration, item.id, currentUser).catch(() => undefined);
      if (record) {
        result.record = record;
        result.version = record.version;
      }
    }
    return result;
  }

  protected async applyItem(
    registration: SyncModelRegistration,
    item: ISyncPushItem,
    currentUser: any,
  ): Promise<ISyncPushResult> {
    const current = await this.findVisible(registration, item.id, currentUser);
    if (item.op === 'delete') {
      return this.applyDelete(registration, item, current, currentUser);
    }
    if (item.baseVersion === undefined) {
      // A create: an id the caller may see is answered with that record — never compared with `data`, so the answer
      // cannot test guesses for fields hidden from the caller (protocol §3)
      return current ? conflict(item, current) : this.applyCreate(registration, item, currentUser);
    }
    if (!current) {
      return reply(item, 'not_found');
    }
    if (current.deletedAt) {
      // Never a silent resurrection
      return conflict(item, current);
    }
    return this.applyUpdate(registration, item, currentUser);
  }

  protected async applyCreate(
    registration: SyncModelRegistration,
    item: ISyncPushItem,
    currentUser: any,
  ): Promise<ISyncPushResult> {
    let input: Record<string, unknown>;
    try {
      input = await this.validateInput(registration.createInput, item.data);
    } catch (error) {
      return this.writeFailure(registration, item, error, currentUser);
    }
    if (registration.tenantScoped && resolveTenantScope().kind === 'tenants') {
      // A create needs the one tenant it is created in (`X-Tenant-Id`). With the caller's membership list nothing can
      // stamp it: MongoDB would store the record without a tenant, invisible to everyone after, and SQL refuses it
      // (row-level security, the row check) — answered alike on every database
      return reply(item, 'rejected', { code: 'FORBIDDEN' });
    }
    try {
      await registration.service.create(input as any, {
        createId: item.id,
        currentUser,
        inputType: registration.createInput,
        roles: [...registration.roles.create],
      });
      // The store writes version 1 on every insert of a synchronized model
      return reply(item, 'applied', { version: 1 });
    } catch (error) {
      return this.writeFailure(registration, item, error, currentUser);
    }
  }

  protected async applyUpdate(
    registration: SyncModelRegistration,
    item: ISyncPushItem,
    currentUser: any,
  ): Promise<ISyncPushResult> {
    let input: Record<string, unknown>;
    try {
      input = await this.validateInput(registration.updateInput, item.data);
    } catch (error) {
      return this.writeFailure(registration, item, error, currentUser);
    }
    try {
      // Conditional on the base version, so the change's version is exactly the next one
      await this.update(registration, item.id, input, item.baseVersion, currentUser);
      return reply(item, 'applied', { version: item.baseVersion + 1 });
    } catch (error) {
      if (error instanceof VersionConflictError) {
        return this.resolveUpdateConflict(registration, item, input, currentUser);
      }
      if (error instanceof NotFoundException) {
        // Deleted between the lookup and the write
        const now = await this.findVisible(registration, item.id, currentUser);
        return now ? conflict(item, now) : reply(item, 'not_found');
      }
      return this.writeFailure(registration, item, error, currentUser);
    }
  }

  /** A change based on an older version, decided by the model's strategy (protocol §6.4) */
  protected async resolveUpdateConflict(
    registration: SyncModelRegistration,
    item: ISyncPushItem,
    input: Record<string, unknown>,
    currentUser: any,
  ): Promise<ISyncPushResult> {
    switch (registration.strategy) {
      case 'lww':
        return this.reapply(registration, item, input, 'applied', currentUser);
      case 'merge': {
        const changed = (item.fields ?? Object.keys(item.data ?? {})).filter((field) => field in input);
        if (changed.some((field) => registration.fieldStrategies[field] === 'reject')) {
          return this.currentConflict(registration, item, currentUser);
        }
        return this.reapply(registration, item, pick(input, changed), 'merged', currentUser);
      }
      case 'custom':
        return this.applyCustom(registration, item, currentUser);
      default:
        return this.currentConflict(registration, item, currentUser);
    }
  }

  protected async applyDelete(
    registration: SyncModelRegistration,
    item: ISyncPushItem,
    current: ISyncRecord | undefined,
    currentUser: any,
  ): Promise<ISyncPushResult> {
    if (item.baseVersion === undefined) {
      return reply(item, 'rejected', {
        code: 'VALIDATION_FAILED',
        details: [{ constraints: { isDefined: 'baseVersion is required for a delete' }, property: 'baseVersion' }],
      });
    }
    if (!current) {
      return reply(item, 'not_found');
    }
    if (current.deletedAt) {
      // Deleted already: what the client wanted is what the server has
      return reply(item, 'applied', { version: current.version });
    }
    try {
      await this.remove(registration, item.id, item.baseVersion, currentUser);
      return reply(item, 'applied', { version: item.baseVersion + 1 });
    } catch (error) {
      if (error instanceof VersionConflictError) {
        switch (registration.strategy) {
          case 'lww':
            return this.reapplyDelete(registration, item, currentUser);
          case 'custom':
            return this.applyCustom(registration, item, currentUser);
          default:
            // `reject`, and `merge`: a deletion cannot be merged field by field with somebody else's change
            return this.currentConflict(registration, item, currentUser);
        }
      }
      if (error instanceof NotFoundException) {
        const now = await this.findVisible(registration, item.id, currentUser);
        return now?.deletedAt ? reply(item, 'applied', { version: now.version }) : reply(item, 'not_found');
      }
      return this.writeFailure(registration, item, error, currentUser);
    }
  }

  /** The `custom` strategy: the model service decides; its answer is written through the same pipeline */
  protected async applyCustom(
    registration: SyncModelRegistration,
    item: ISyncPushItem,
    currentUser: any,
  ): Promise<ISyncPushResult> {
    const server = await this.findVisible(registration, item.id, currentUser);
    if (!server) {
      return reply(item, 'not_found');
    }
    if (server.deletedAt) {
      return conflict(item, server);
    }
    const context: ISyncConflictContext = {
      change: { baseVersion: item.baseVersion, data: item.data, fields: item.fields, op: item.op },
      currentUser,
      id: item.id,
      model: registration.name,
      server,
    };
    const resolution: SyncConflictResolution = await (registration.service as any).resolveSyncConflict(context);
    if (!resolution || 'refuse' in resolution) {
      return reply(item, 'rejected', { code: 'CUSTOM_REFUSED' });
    }
    if ('delete' in resolution) {
      return this.reapplyDelete(registration, item, currentUser);
    }
    let input: Record<string, unknown>;
    try {
      input = await this.validateInput(registration.updateInput, resolution.data);
    } catch (error) {
      return this.writeFailure(registration, item, error, currentUser);
    }
    return this.reapply(registration, item, input, 'merged', currentUser);
  }

  /**
   * Write `input` on top of the CURRENT version — still one conditional statement, so a change arriving meanwhile is
   * never overwritten unseen; tried again a few times, then `retry`
   */
  protected async reapply(
    registration: SyncModelRegistration,
    item: ISyncPushItem,
    input: Record<string, unknown>,
    status: 'applied' | 'merged',
    currentUser: any,
  ): Promise<ISyncPushResult> {
    for (let attempt = 0; attempt < SYNC_REAPPLY_ATTEMPTS; attempt++) {
      const current = await this.findVisible(registration, item.id, currentUser);
      if (!current) {
        return reply(item, 'not_found');
      }
      if (current.deletedAt) {
        return conflict(item, current);
      }
      try {
        await this.update(registration, item.id, input, current.version, currentUser);
        if (status === 'applied') {
          return reply(item, 'applied', { version: current.version + 1 });
        }
        const record = await this.findVisible(registration, item.id, currentUser);
        return reply(item, 'merged', { ...(record ? { record } : {}), version: current.version + 1 });
      } catch (error) {
        if (!(error instanceof VersionConflictError) && !(error instanceof NotFoundException)) {
          return this.writeFailure(registration, item, error, currentUser);
        }
      }
    }
    return reply(item, 'retry');
  }

  protected async reapplyDelete(
    registration: SyncModelRegistration,
    item: ISyncPushItem,
    currentUser: any,
  ): Promise<ISyncPushResult> {
    for (let attempt = 0; attempt < SYNC_REAPPLY_ATTEMPTS; attempt++) {
      const current = await this.findVisible(registration, item.id, currentUser);
      if (!current) {
        return reply(item, 'not_found');
      }
      if (current.deletedAt) {
        return reply(item, 'applied', { version: current.version });
      }
      try {
        await this.remove(registration, item.id, current.version, currentUser);
        return reply(item, 'applied', { version: current.version + 1 });
      } catch (error) {
        if (!(error instanceof VersionConflictError) && !(error instanceof NotFoundException)) {
          return this.writeFailure(registration, item, error, currentUser);
        }
      }
    }
    return reply(item, 'retry');
  }

  protected async currentConflict(
    registration: SyncModelRegistration,
    item: ISyncPushItem,
    currentUser: any,
  ): Promise<ISyncPushResult> {
    const current = await this.findVisible(registration, item.id, currentUser);
    return current ? conflict(item, current) : reply(item, 'not_found');
  }

  /** The conditional update through the model's CrudService, with the update roles */
  protected update(
    registration: SyncModelRegistration,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number,
    currentUser: any,
  ): Promise<unknown> {
    return registration.service.update(id, input as any, {
      currentUser,
      expectedVersion,
      inputType: registration.updateInput,
      roles: [...registration.roles.update],
    });
  }

  /**
   * The conditional delete through the model's CrudService, with the DELETE roles — a synchronized model's delete leaves
   * a tombstone on every path, so a hard delete is not reachable from here
   */
  protected remove(
    registration: SyncModelRegistration,
    id: string,
    expectedVersion: number,
    currentUser: any,
  ): Promise<unknown> {
    return registration.service.delete(id, { currentUser, expectedVersion, roles: [...registration.roles.delete] });
  }

  /**
   * The record as the caller may see it now — tombstones included — or `undefined`: missing, in another tenant, without
   * the model's pull roles, or hidden by `securityCheck()` all look alike
   */
  protected async findVisible(
    registration: SyncModelRegistration,
    id: string,
    currentUser: any,
  ): Promise<ISyncRecord | undefined> {
    // The system fields first, the content second, as in a pull: a version is never newer than the content it labels,
    // so a client resolving a conflict against this record cannot silently overwrite a change it was not shown
    const [raw] = (await this.readSystemFields(registration, [id])).values();
    if (!raw) {
      return undefined;
    }
    try {
      // With the pull roles: a push answers with a record only to a caller who may pull it (protocol §1.3)
      const record = await registration.service.get(String(raw.id), {
        currentUser,
        includeTombstones: true,
        roles: [...registration.roles.pull],
      });
      return this.toSyncRecord(registration, record, raw, currentUser);
    } catch (error) {
      // Not there, or not the caller's to see: answered exactly like an unknown id
      if (
        error instanceof NotFoundException ||
        error instanceof ForbiddenException ||
        error instanceof UnauthorizedException
      ) {
        return undefined;
      }
      throw error;
    }
  }

  /** `data` validated and whitelisted against the model's input class, exactly like a request body */
  protected async validateInput(inputType: Type<any>, data: unknown): Promise<Record<string, unknown>> {
    const value = await new MapAndValidatePipe().transform(
      data && typeof data === 'object' ? { ...(data as object) } : {},
      { metatype: inputType, type: 'body' },
    );
    return { ...(value as Record<string, unknown>) };
  }

  /**
   * A write the pipeline refused, as an item status — or rethrown when it is transient (the caller answers `retry`).
   * A create on an id that is taken: the caller's own record (two creates of one id at once) is a conflict, anything
   * else `ID_UNAVAILABLE` — the same answer for every reason an id cannot be used (protocol §3).
   */
  protected async writeFailure(
    registration: SyncModelRegistration,
    item: ISyncPushItem,
    error: unknown,
    currentUser: any,
  ): Promise<ISyncPushResult> {
    if ((error instanceof DuplicateKeyError && error.primaryKey) || isDuplicateIdError(error)) {
      const now = await this.findVisible(registration, item.id, currentUser);
      return now ? conflict(item, now) : reply(item, 'rejected', { code: 'ID_UNAVAILABLE' });
    }
    if (error instanceof ForbiddenException || error instanceof UnauthorizedException) {
      return reply(item, 'rejected', { code: 'FORBIDDEN' });
    }
    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      const details =
        error instanceof DuplicateKeyError
          ? undefined
          : response && typeof response === 'object'
            ? omit(response as Record<string, unknown>, ['error', 'statusCode'])
            : undefined;
      return reply(item, 'rejected', { code: 'VALIDATION_FAILED', ...(details ? { details } : {}) });
    }
    if (error instanceof QueryCastError || error instanceof UnsupportedQueryError || isMongoDuplicate(error)) {
      return reply(item, 'rejected', { code: 'VALIDATION_FAILED' });
    }
    throw error;
  }

  // ===================================================================================================================
  // Requests: rate limits and the origin of a push (protocol §4)
  // ===================================================================================================================

  /**
   * Count one pull or push of the caller; the seconds until the window resets when the limit is exceeded, `undefined`
   * while within it (or when the limit is switched off)
   */
  async rateLimit(kind: 'pull' | 'push', currentUser: any): Promise<number | undefined> {
    const all = this.config.rateLimit;
    const own = all === false ? false : all?.[kind];
    if (own === false) {
      return undefined;
    }
    const defaults = kind === 'pull' ? SYNC_DEFAULTS.rateLimitPull : SYNC_DEFAULTS.rateLimitPush;
    const max = positiveNumber(own?.max, defaults.max);
    const windowSeconds = positiveNumber(own?.windowSeconds, defaults.windowSeconds);
    const hit = await this.getRateLimitStore().hit(`${kind}:${String(getStringIds(currentUser?.id))}`, windowSeconds);
    return hit.count > max ? Math.max(1, hit.resetIn) : undefined;
  }

  protected getRateLimitStore(): RateLimitStore {
    this.rateLimitStore ??= this.redisService?.enabled
      ? new RedisRateLimitStore(this.redisService, 'sync')
      : new InMemoryRateLimitStore(10_000);
    return this.rateLimitStore;
  }

  /**
   * The request rules of a push: a JSON body (which forces a CORS preflight in a browser), and — while the server uses
   * cookies, i.e. a browser may hold an ambient credential — no cross-site request and no untrusted `Origin`. A client
   * without fetch metadata (a native app, a server) sends neither header and is not affected.
   */
  assertPushRequest(request: any): void {
    const contentType = String(request?.headers?.['content-type'] ?? '');
    if (!/^application\/json\b/i.test(contentType)) {
      throw new BadRequestException(`${ErrorCode.SYNC_INVALID_REQUEST}: Content-Type must be application/json`);
    }
    const config = ConfigService.configFastButReadOnly ?? {};
    if (!isCookiesEnabled(config.cookies)) {
      return;
    }
    if (String(request?.headers?.['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
      throw new ForbiddenException(ErrorCode.SYNC_ORIGIN_REFUSED);
    }
    const origin = request?.headers?.origin;
    if (typeof origin === 'string' && origin && !this.isTrustedOrigin(origin)) {
      throw new ForbiddenException(ErrorCode.SYNC_ORIGIN_REFUSED);
    }
  }

  /** The origins credentialed CORS answers (`cors`), plus the app and API origins themselves */
  protected isTrustedOrigin(origin: string): boolean {
    const config = ConfigService.configFastButReadOnly ?? {};
    const cors = buildCorsConfig(config) as { origin?: boolean | string[] };
    if (cors.origin === true) {
      return true;
    }
    const corsConfig = typeof config.cors === 'object' ? config.cors : {};
    const { appUrl, baseUrl } = resolveServerUrls({
      appUrl: config.appUrl,
      baseUrl: config.baseUrl,
      deriveAppUrl: corsConfig?.deriveAppUrl,
      env: config.env,
    });
    const trusted = new Set<string>(Array.isArray(cors.origin) ? cors.origin : []);
    for (const url of [appUrl, baseUrl]) {
      const value = originOf(url);
      if (value) {
        trusted.add(value);
      }
    }
    return trusted.has(originOf(origin) ?? origin);
  }

  // ===================================================================================================================
  // Access epochs (plan §3.8) — reported by CrudService and the tenant guard
  // ===================================================================================================================

  /**
   * Make the clients concerned resync their next pull: every member of `tenantId` (no `userId`), or one user. For a
   * write that moves records past `CrudService.update()` — the store or the native API do not report it.
   */
  async bumpAccessEpoch(model: string, tenantId: string | undefined, userId?: string): Promise<void> {
    const tenant = tenantId ?? '-';
    await this.stateStore.bump(
      userId
        ? CoreSyncStateStore.userEpochKey(model, tenant, userId)
        : CoreSyncStateStore.tenantEpochKey(model, tenant),
    );
  }

  async recordMoved(move: SyncRecordMove): Promise<void> {
    if (!this.models.has(move.model)) {
      return;
    }
    if (move.tenantChanged) {
      await this.bumpAccessEpoch(move.model, move.tenantId);
    }
    for (const user of move.usersLost) {
      await this.bumpAccessEpoch(move.model, move.tenantId, user);
    }
  }

  async tenantInvalidated(tenantId: string): Promise<void> {
    for (const registration of this.models.values()) {
      if (registration.tenantScoped) {
        await this.bumpAccessEpoch(registration.name, tenantId);
      }
    }
  }

  /** The tombstone horizon of a model — the purge (DEV-3902) advances it before it deletes */
  advanceHorizon(model: string, at: Date): Promise<void> {
    return this.stateStore.advanceHorizon(model, at);
  }

  // ===================================================================================================================
  // Helpers
  // ===================================================================================================================

  /** 410: the client deletes its records of the model and pulls without a cursor (protocol §8) */
  protected resync(reason: SyncResyncReason): never {
    throw new SyncResyncRequiredException(reason);
  }

  /** A store call whose failure (an outage, not a refusal) answers 503 */
  protected async storeCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Sync: store unavailable (${(error as Error)?.message ?? error})`, (error as Error)?.stack);
      throw new ServiceUnavailableException(ErrorCode.SYNC_STORE_UNAVAILABLE);
    }
  }
}

function reply(
  item: ISyncPushItem,
  status: ISyncPushResult['status'],
  extra: Partial<ISyncPushResult> = {},
): ISyncPushResult {
  return { id: item.id, mutationId: item.mutationId, status, ...extra };
}

function conflict(item: ISyncPushItem, record: ISyncRecord): ISyncPushResult {
  return reply(item, 'conflict', { record, version: record.version });
}

/** The id of a CrudService output record (`id` is declared readable for everyone by `CorePersistenceModel`) */
function recordId(record: any): string {
  const id = record?.id ?? record?._id;
  return id === undefined || id === null ? '' : String(getStringIds(id));
}

function initialPosition(order: 'clock' | 'seq'): SyncCursorPosition {
  return order === 'seq' ? { seq: 0 } : { at: 0, id: '' };
}

function pick(input: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => field in input).map((field) => [field, input[field]]));
}

function omit(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function originOf(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/** A MongoDB duplicate-key error on a field other than the id (a unique index of the model) */
function isMongoDuplicate(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 11000;
}
