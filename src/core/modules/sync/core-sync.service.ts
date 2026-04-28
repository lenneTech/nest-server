import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PubSub as PubSubInstance } from 'graphql-subscriptions';
import { Connection } from 'mongoose';

import { checkRestricted } from '../../common/decorators/restricted.decorator';
import { getSyncFieldStrategies } from '../../common/decorators/syncable.decorator';
import { ProcessType } from '../../common/enums/process-type.enum';
import { SyncConflictException } from '../../common/exceptions/sync-conflict.exception';
import { ConfigService } from '../../common/services/config.service';
import { ISyncPullResponse, ISyncPushItem, ISyncPushResponse, ISyncPushResult, ISyncRegistryEntry, ISyncStreamEvent } from './sync.interfaces';
import { buildSyncIdempotencyKeySchema } from './sync-idempotency.schema';

export const SYNC_PUB_SUB = 'SYNC_PUB_SUB';
export const SYNC_MODELS = 'SYNC_MODELS';

/**
 * Internal symbol used by tests/admin tools to reset the SyncRegistry.
 * Not exported publicly.
 */
const REGISTRY_RESET = Symbol('syncRegistryReset');

/**
 * Module-scoped registry of syncable models. Append-only. Frozen after
 * application bootstrap to prevent runtime tampering (R16 in plan).
 */
class SyncRegistry {
  private readonly entries = new Map<string, ISyncRegistryEntry>();
  private frozen = false;

  register(entry: ISyncRegistryEntry): void {
    if (this.frozen) {
      throw new Error(`SyncRegistry is frozen — cannot register "${entry.name}" after bootstrap`);
    }
    this.entries.set(entry.name, entry);
  }

  get(name: string): ISyncRegistryEntry | undefined {
    return this.entries.get(name);
  }

  list(): ISyncRegistryEntry[] {
    return Array.from(this.entries.values());
  }

  freeze(): void {
    this.frozen = true;
  }

  /** @internal */
  [REGISTRY_RESET](): void {
    this.entries.clear();
    this.frozen = false;
  }
}

/**
 * Core service for offline sync. Orchestrates:
 *
 * - Bulk push (with DTO validation, idempotency, conflict resolution).
 * - Delta pull (delegated to the model's CrudService.findChangesSince()).
 * - WebSocket "changes available" hint emission with debounce.
 *
 * All write paths go through the model's CrudService — restricted-field
 * checks, securityCheck, tenant filtering, audit fields, role guard
 * are all preserved. The service NEVER bypasses these mechanisms.
 *
 * @see ISyncConfig
 */
@Injectable()
export class CoreSyncService implements OnApplicationBootstrap {
  protected readonly logger = new Logger(CoreSyncService.name);
  protected readonly registry = new SyncRegistry();

  /** Debounce timers keyed by `${modelName}:${tenantId || ''}`. */
  protected readonly hintTimers = new Map<string, NodeJS.Timeout>();

  /** Idempotency cache model — created lazily during bootstrap. */
  protected idempotencyModel: any = null;

  constructor(
    protected readonly moduleRef: ModuleRef,
    @Inject(SYNC_MODELS) protected readonly modelEntries: any[],
    @Optional() @Inject(SYNC_PUB_SUB) protected readonly pubSub?: PubSubInstance,
  ) {}

  /**
   * Bootstrap: resolves CrudService instances from DI, caches Reflect
   * metadata for field strategies, validates incompatible decorator
   * combinations, and freezes the registry.
   */
  async onApplicationBootstrap() {
    // Build registry entries from raw model entries provided to the module.
    const cfg = this.getConfig();
    const defaultMaxPushBatch = cfg?.maxPushBatch ?? 200;
    const defaultMaxLimit = cfg?.maxLimit ?? 1000;

    for (const raw of this.modelEntries || []) {
      let serviceInstance: any = null;
      try {
        serviceInstance = this.moduleRef.get(raw.service, { strict: false });
      } catch (e) {
        this.logger.warn(
          `Could not resolve sync service for "${raw.name}" — module may need explicit imports. Reason: ${e?.message || e}`,
        );
      }

      const fieldStrategies =
        raw.createDto || raw.updateDto
          ? getSyncFieldStrategies(raw.updateDto || raw.createDto)
          : new Map<string, 'lww' | 'strict'>();

      // Build-time check: a field cannot be both lww AND restricted-write.
      // Restricted metadata is set by @Restricted on the model — we only
      // warn when there is a clear collision (the @Restricted metadata
      // would override the lww strategy at runtime, making the marker
      // misleading).
      const dtoCtor = raw.updateDto || raw.createDto;
      if (dtoCtor) {
        const proto = dtoCtor.prototype;
        for (const [field, strategy] of fieldStrategies) {
          if (strategy !== 'lww') continue;
          const restricted =
            Reflect.getMetadata && Reflect.getMetadata('restricted', proto, field);
          if (restricted) {
            this.logger.warn(
              `[Sync] Field "${field}" on ${raw.name} is marked @SyncField('lww') but also @Restricted. ` +
                `LWW will be ineffective because Restricted blocks the write.`,
            );
          }
        }
      }

      this.registry.register({
        conflictStrategy: raw.conflictStrategy || 'reject',
        createDto: raw.createDto,
        customConflictResolver: raw.customConflictResolver,
        fieldStrategies,
        maxLimit: raw.maxLimit ?? defaultMaxLimit,
        maxPushBatch: raw.maxPushBatch ?? defaultMaxPushBatch,
        name: raw.name,
        onConflict: raw.onConflict,
        pullLean: raw.pullLean === true,
        service: serviceInstance,
        streamEnabled: raw.streamEnabled === true,
        streamFilter: raw.streamFilter,
        streamTransform: raw.streamTransform,
        tombstoneIndex: raw.tombstoneIndex !== false,
        updateDto: raw.updateDto || raw.createDto,
      });
    }

    // Initialise idempotency model if enabled.
    if (this.isIdempotencyEnabled()) {
      try {
        const conn = this.moduleRef.get(Connection, { strict: false });
        if (conn) {
          const ttl = this.getConfig()?.idempotency?.ttlSeconds ?? 86400;
          const collectionName =
            this.getConfig()?.idempotency?.collectionName ?? 'sync_idempotency_keys';
          const schema = buildSyncIdempotencyKeySchema(ttl);
          this.idempotencyModel = (conn as any).models[collectionName]
            ? (conn as any).models[collectionName]
            : (conn as any).model(collectionName, schema, collectionName);
        }
      } catch (e) {
        this.logger.warn(`Failed to initialise idempotency model: ${e?.message || e}`);
      }
    }

    // Install hint emission hooks on registered model schemas.
    if (this.isHintEnabled() && this.pubSub) {
      for (const entry of this.registry.list()) {
        if (!entry.service) continue;
        try {
          const model = entry.service.getModel ? entry.service.getModel() : entry.service.mainDbModel;
          if (!model?.schema) continue;
          const emit = () => this.scheduleHint(entry.name);
          model.schema.post('save', emit);
          model.schema.post('findOneAndUpdate', emit);
          model.schema.post('insertMany', () => this.scheduleHint(entry.name));
        } catch (e) {
          this.logger.warn(`Could not attach sync hint hooks for "${entry.name}": ${e?.message || e}`);
        }
      }
    }

    // Install real-time stream emission hooks (only on stream-enabled models).
    if (this.isStreamEnabled() && this.pubSub) {
      for (const entry of this.registry.list()) {
        if (!entry.streamEnabled || !entry.service) continue;
        try {
          const model = entry.service.getModel ? entry.service.getModel() : entry.service.mainDbModel;
          if (!model?.schema) continue;
          const onSave = (doc: any) => {
            if (!doc) return;
            const op: 'updated' | 'deleted' = doc.deletedAt ? 'deleted' : 'updated';
            this.handleStreamMutation(entry.name, op, doc);
          };
          const onCreated = (doc: any) => {
            if (!doc) return;
            this.handleStreamMutation(entry.name, 'created', doc);
          };
          // For Mongoose, `save` on a new document fires after the document has its _id.
          // The 'isNew' state is no longer accessible after save, so we use the
          // version field as a heuristic: version=1 + no prior updates ≈ created.
          // For findOneAndUpdate this is always an update or soft-delete.
          model.schema.post('save', function (doc: any) {
            if (doc?.version === 1) onCreated(doc);
            else onSave(doc);
          });
          model.schema.post('findOneAndUpdate', onSave);
          model.schema.post('insertMany', (docs: any[]) => {
            for (const d of docs || []) onCreated(d);
          });
        } catch (e) {
          this.logger.warn(`Could not attach sync stream hooks for "${entry.name}": ${e?.message || e}`);
        }
      }
    }

    // Freeze registry to prevent runtime tampering.
    this.registry.freeze();
    this.logger.log(`Sync feature initialised with ${this.registry.list().length} model(s) registered.`);
  }

  /**
   * Pulls the next window of changes for `modelName` strictly after `cursor`.
   */
  async pull(
    modelName: string,
    cursor: { updatedAt: Date; id: string } | null,
    options: { limit?: number; serviceOptions?: any } = {},
  ): Promise<ISyncPullResponse> {
    const entry = this.requireEntry(modelName);
    const limit = Math.min(options.limit ?? this.getConfig()?.defaultLimit ?? 200, entry.maxLimit);
    const result = await entry.service.findChangesSince(cursor, {
      lean: entry.pullLean,
      limit,
      serviceOptions: options.serviceOptions,
    });
    return {
      changes: result.changes,
      cursor: result.cursor ? this.encodeCursor(result.cursor) : null,
      hasMore: result.hasMore,
    };
  }

  /**
   * Push a batch of items to `modelName`. Each item is validated against
   * the registered DTO, deduplicated via idempotency cache, and dispatched
   * to create/update/delete with optimistic concurrency.
   */
  async push(
    modelName: string,
    items: ISyncPushItem[],
    serviceOptions: any,
  ): Promise<ISyncPushResponse> {
    const entry = this.requireEntry(modelName);

    if (!Array.isArray(items)) {
      throw new BadRequestException('items must be an array');
    }
    if (items.length > entry.maxPushBatch) {
      throw new BadRequestException(
        `Bulk push too large: ${items.length} items, max ${entry.maxPushBatch}`,
      );
    }

    const userId = serviceOptions?.currentUser?.id;

    // Bulk read of idempotency keys (P1).
    const cachedResults = await this.lookupIdempotencyKeys(modelName, items, userId);

    const results: ISyncPushResult[] = [];

    for (const item of items) {
      // Cached result hit?
      if (item.clientId && cachedResults.has(item.clientId)) {
        results.push(cachedResults.get(item.clientId)!);
        continue;
      }

      const result = await this.processItem(entry, item, serviceOptions);
      results.push(result);

      // Persist idempotency entry.
      if (item.clientId && this.idempotencyModel) {
        await this.storeIdempotency(modelName, item.clientId, userId, result);
      }
    }

    return { results };
  }

  /**
   * Process a single push item (create / update / delete).
   */
  protected async processItem(
    entry: ISyncRegistryEntry,
    item: ISyncPushItem,
    serviceOptions: any,
  ): Promise<ISyncPushResult> {
    // Hard-delete is NEVER allowed via the sync layer, regardless of input (R14).
    const safeOptions = { ...(serviceOptions || {}), hardDelete: false };

    // Strip sync-internal fields from any data the client tries to send.
    const cleanData = this.stripSyncMeta(item.data || {});

    // DTO validation pre-flight.
    if (item.id && entry.updateDto) {
      const validation = await this.validateDto(cleanData, entry.updateDto);
      if (validation) return { clientId: item.clientId, id: item.id, message: validation, status: 'invalid' };
    } else if (!item.id && entry.createDto) {
      const validation = await this.validateDto(cleanData, entry.createDto);
      if (validation) return { clientId: item.clientId, message: validation, status: 'invalid' };
    }

    try {
      // DELETE
      if (item.deleted && item.id) {
        await entry.service.delete(item.id, { ...safeOptions, expectedVersion: item.version });
        return { clientId: item.clientId, id: item.id, status: 'applied' };
      }

      // UPDATE
      if (item.id) {
        const updated = await entry.service.update(item.id, cleanData, {
          ...safeOptions,
          expectedVersion: item.version,
        });
        return {
          clientId: item.clientId,
          id: this.docId(updated),
          serverVersion: (updated as any)?.version,
          status: 'applied',
        };
      }

      // CREATE
      const created = await entry.service.create(cleanData, safeOptions);
      return {
        clientId: item.clientId,
        id: this.docId(created),
        serverVersion: (created as any)?.version,
        status: 'applied',
      };
    } catch (e: any) {
      if (e instanceof NotFoundException) {
        return { clientId: item.clientId, id: item.id, status: 'not_found' };
      }
      if (e instanceof SyncConflictException) {
        // Notify hook (always — even if a strategy resolves the conflict).
        if (entry.onConflict) {
          try {
            await entry.onConflict({
              clientVersion: e.payload.clientVersion,
              itemId: e.payload.id,
              modelName: entry.name,
              serverVersion: e.payload.serverVersion,
              userId: serviceOptions?.currentUser?.id,
            });
          } catch (hookErr) {
            this.logger.warn(`onConflict hook failed: ${hookErr?.message || hookErr}`);
          }
        }

        // Apply the configured conflict strategy.
        const resolved = await this.applyConflictStrategy(
          entry,
          item,
          cleanData,
          e,
          safeOptions,
          serviceOptions,
        );
        if (resolved) return resolved;

        // Strategy did not resolve → fall back to plain conflict response.
        return {
          clientId: item.clientId,
          id: e.payload.id,
          serverState: e.payload.serverState,
          serverVersion: e.payload.serverVersion,
          status: 'conflict',
        };
      }
      this.logger.warn(`Sync push item failed for ${entry.name}: ${e?.message || e}`);
      return { clientId: item.clientId, id: item.id, message: e?.message || 'unknown error', status: 'error' };
    }
  }

  /**
   * Dispatch to the configured conflict strategy.
   *
   * - `'reject'` (default): no recovery — the caller falls back to a
   *   regular `conflict` response with `serverState`.
   * - `'lww'`: ignore the client's `expectedVersion` and apply the
   *   payload on top of the server state with the up-to-date version.
   *   Mirrors PowerSync's "client wins" behavior for non-collaborative
   *   data. Use sparingly — silent overwrite of concurrent edits.
   * - `'merge'`: per-field LWW for fields decorated `@SyncField('lww')`.
   *   Strict-decorated or undecorated fields fall back to conflict if
   *   they diverge.
   * - `'custom'`: invoke the registered `customConflictResolver`. The
   *   resolver returns a merged patch (applied with the up-to-date
   *   `expectedVersion`) or `undefined` to fall through to conflict.
   *
   * Whatever strategy runs, the resulting write goes through the
   * regular `CrudService.update()` pipeline — `@Restricted` input check,
   * `securityCheck`, all Mongoose plugins. Field-level LWW does not
   * bypass any security mechanism.
   */
  protected async applyConflictStrategy(
    entry: ISyncRegistryEntry,
    item: ISyncPushItem,
    clientPatch: Record<string, any>,
    conflict: SyncConflictException,
    safeOptions: any,
    serviceOptions: any,
  ): Promise<ISyncPushResult | undefined> {
    const strategy = entry.conflictStrategy || 'reject';

    if (strategy === 'reject') return undefined;

    if (strategy === 'merge') {
      return this.tryFieldLevelMerge(entry, item, clientPatch, conflict, safeOptions);
    }

    if (strategy === 'lww') {
      // Re-apply the client patch on top of the current server version.
      // No expectedVersion check — the server "trusts" the client's intent.
      try {
        const updated = await entry.service.update(item.id, clientPatch, {
          ...safeOptions,
          expectedVersion: conflict.payload.serverVersion,
        });
        return {
          clientId: item.clientId,
          id: this.docId(updated),
          serverVersion: (updated as any)?.version,
          status: 'merged',
        };
      } catch (e) {
        // A concurrent third write happened during the LWW retry —
        // fall back to plain conflict.
        return undefined;
      }
    }

    if (strategy === 'custom') {
      if (!entry.customConflictResolver) {
        this.logger.warn(
          `[Sync] conflictStrategy='custom' on ${entry.name} but no customConflictResolver registered. Falling back to reject.`,
        );
        return undefined;
      }
      try {
        const resolverPatch = await entry.customConflictResolver({
          clientPatch,
          clientVersion: conflict.payload.clientVersion,
          itemId: conflict.payload.id,
          modelName: entry.name,
          serverState: conflict.payload.serverState,
          serverVersion: conflict.payload.serverVersion,
          user: this.toStreamUser(serviceOptions?.currentUser),
        });
        if (!resolverPatch) return undefined;
        const updated = await entry.service.update(item.id, resolverPatch, {
          ...safeOptions,
          expectedVersion: conflict.payload.serverVersion,
        });
        return {
          clientId: item.clientId,
          id: this.docId(updated),
          serverVersion: (updated as any)?.version,
          status: 'merged',
        };
      } catch (e) {
        this.logger.warn(`customConflictResolver failed: ${e?.message || e}`);
        return undefined;
      }
    }

    return undefined;
  }

  /**
   * Project a request user onto the lightweight surface exposed to
   * project hooks (streamFilter, streamTransform, customConflictResolver).
   * Avoids leaking unrelated fields and keeps hook signatures stable.
   */
  protected toStreamUser(currentUser: any): any {
    if (!currentUser) return undefined;
    return {
      hasRole: typeof currentUser.hasRole === 'function' ? currentUser.hasRole.bind(currentUser) : undefined,
      id: currentUser.id ?? currentUser._id?.toString(),
      roles: Array.isArray(currentUser.roles) ? [...currentUser.roles] : undefined,
      tenantIds: Array.isArray(currentUser.tenantIds) ? [...currentUser.tenantIds] : undefined,
    };
  }

  /**
   * Attempt a field-level Last-Write-Wins merge. If only fields with the
   * 'lww' strategy diverge between client and server, the server picks
   * the side with the newer updatedAt timestamp per field and writes the
   * merged document back. If any 'strict' field diverges OR a 'lww' field
   * is also @Restricted (write-protected), bail out and return undefined
   * — the caller will report a conflict.
   */
  protected async tryFieldLevelMerge(
    entry: ISyncRegistryEntry,
    item: ISyncPushItem,
    clientPatch: Record<string, any>,
    conflict: SyncConflictException,
    safeOptions: any,
  ): Promise<ISyncPushResult | undefined> {
    if (!entry.fieldStrategies.size || !item.id) return undefined;

    const server = conflict.payload.serverState || {};
    const lwwPatch: Record<string, any> = {};
    let anyDivergence = false;

    for (const [field, value] of Object.entries(clientPatch)) {
      if (server[field] === value) continue;
      anyDivergence = true;
      const strategy = entry.fieldStrategies.get(field) || 'strict';
      if (strategy === 'strict') {
        return undefined;
      }
      lwwPatch[field] = value;
    }

    if (!anyDivergence) {
      // Nothing actually changed — treat as a no-op success.
      return {
        clientId: item.clientId,
        id: item.id,
        serverVersion: conflict.payload.serverVersion,
        status: 'applied',
      };
    }

    // Re-attempt the write with the actual server version so it succeeds.
    try {
      const updated = await entry.service.update(item.id, lwwPatch, {
        ...safeOptions,
        expectedVersion: conflict.payload.serverVersion,
      });
      return {
        clientId: item.clientId,
        id: this.docId(updated),
        serverVersion: (updated as any)?.version,
        status: 'merged',
      };
    } catch (e) {
      // Race lost again — bail to plain conflict.
      return undefined;
    }
  }

  /**
   * Validate a payload object against a DTO class. Returns an error string
   * on failure or undefined on success. Uses the same class-validator
   * stack as the global MapAndValidatePipe.
   */
  protected async validateDto(payload: any, dtoCtor: any): Promise<string | undefined> {
    try {
      const instance = plainToInstance(dtoCtor, payload, { excludeExtraneousValues: false });
      const errors = await validate(instance, {
        forbidNonWhitelisted: false,
        whitelist: true,
      });
      if (errors.length) {
        return errors.map((e) => Object.values(e.constraints || {}).join('; ')).join(' | ');
      }
      return undefined;
    } catch (e) {
      return e?.message || 'validation error';
    }
  }

  /**
   * Trigger a debounced hint emission for `modelName`. Reads the current
   * tenant from the request context if available so subscribers in other
   * tenants are filtered out at the resolver layer.
   */
  scheduleHint(modelName: string, tenantId?: string) {
    if (!this.pubSub || !this.isHintEnabled()) return;
    const debounceMs = this.getHintDebounceMs();
    const key = `${modelName}:${tenantId || ''}`;
    const existing = this.hintTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.hintTimers.delete(key);
      const channel = this.getConfig()?.hint && typeof this.getConfig()?.hint === 'object'
        ? (this.getConfig()?.hint as any)?.channel || 'syncHint'
        : 'syncHint';
      this.pubSub!.publish(channel, {
        syncHint: { changedAt: new Date(), model: modelName },
        // Internal-only field — used by resolver filter, not exposed in payload.
        _tenantId: tenantId,
      });
    }, debounceMs);
    if (timer.unref) timer.unref();
    this.hintTimers.set(key, timer);
  }

  /**
   * Mongoose post-hook callback. Emits a stream event for the registered
   * model after a save/update/insert. The actual fan-out, security
   * pipeline, and per-subscriber filtering happens later in the resolver
   * via `streamFilterMatches` and `transformStreamPayload`.
   */
  protected handleStreamMutation(modelName: string, op: 'created' | 'updated' | 'deleted', doc: any) {
    if (!this.pubSub || !this.isStreamEnabled()) return;
    const channel = this.getStreamChannel();
    // Publish the raw doc on the global stream channel. Per-subscriber
    // filtering and transformation happens in the resolver's filter and
    // resolve callbacks — the wire never sees `_doc`.
    this.pubSub.publish(channel, {
      syncStreamRaw: {
        _doc: doc,
        _tenantId: doc?.tenantId,
        model: modelName,
        op,
      },
    });
  }

  /**
   * Async filter for stream subscribers.
   *
   * Called per subscriber per published event. Drops the event if:
   * - Subscriber is not in the model's tenant scope.
   * - Project's `streamFilter` callback returns falsy.
   *
   * Returning `false` here means the subscriber will NOT receive the
   * event — neither the resolver nor any project hook is invoked
   * downstream for that subscriber. This is the cheap pre-filter.
   */
  async streamFilterMatches(payload: any, variables: any, user: any): Promise<boolean> {
    const raw = payload?.syncStreamRaw;
    if (!raw) return false;
    const entry = this.registry.get(raw.model);
    if (!entry?.streamEnabled) return false;

    if (variables?.model && raw.model !== variables.model) return false;

    // Tenant match: if the doc is scoped to a tenant, the subscriber must
    // belong to that tenant. If the doc has no tenant scope, broadcast.
    if (raw._tenantId) {
      const userTenants: string[] | undefined = user?.tenantIds;
      if (!userTenants || !userTenants.length) return false;
      if (!userTenants.map(String).includes(String(raw._tenantId))) return false;
    }

    // Project-level filter (e.g. owner-only).
    if (entry.streamFilter) {
      try {
        const allowed = await entry.streamFilter(this.toStreamUser(user), raw._doc);
        if (!allowed) return false;
      } catch (e) {
        this.logger.warn(`streamFilter for ${entry.name} threw: ${e?.message || e}`);
        return false;
      }
    }

    return true;
  }

  /**
   * Resolves a published raw event into the safe wire payload for one
   * subscriber. Runs the full security pipeline:
   *  1. Clone (never mutate the shared raw doc).
   *  2. `checkRestricted(item, user, OUTPUT)` — strips @Restricted fields.
   *  3. `securityCheck(user)` — model-defined throw-on-forbidden hook.
   *  4. Secret removal — passwords, tokens, etc.
   *  5. Project `streamTransform(user, item)` — final manipulation hook.
   *
   * Returns `undefined` to drop the event for this subscriber (the
   * GraphQL subscription handles undefined by skipping the emission).
   */
  async transformStreamPayload(payload: any, user: any): Promise<ISyncStreamEvent | undefined> {
    const raw = payload?.syncStreamRaw;
    if (!raw) return undefined;
    const entry = this.registry.get(raw.model);
    if (!entry) return undefined;

    // 1. Deep clone — toObject() if Mongoose document, else JSON-clone.
    let item: any;
    try {
      item = raw._doc?.toObject ? raw._doc.toObject() : JSON.parse(JSON.stringify(raw._doc));
    } catch {
      return undefined;
    }
    if (!item) return undefined;

    // 2. @Restricted output filtering.
    try {
      const filtered = checkRestricted(item, this.toStreamUser(user) || {}, {
        processType: ProcessType.OUTPUT,
        throwError: false,
      });
      // checkRestricted may return the same object (mutated) or a new one.
      item = filtered ?? item;
    } catch (e) {
      this.logger.warn(`checkRestricted dropped ${entry.name} event: ${e?.message || e}`);
      return undefined;
    }

    // 3. Model-defined securityCheck. We invoke on the original Mongoose
    //    document (where the method lives) but apply the result to `item`.
    try {
      if (raw._doc && typeof raw._doc.securityCheck === 'function') {
        raw._doc.securityCheck(user);
      }
    } catch {
      return undefined;
    }

    // 4. Secret removal (Safety Net duplicated here because the WS
    //    response interceptor does NOT run on subscription payloads).
    this.removeSecrets(item);

    // 5. Project-level transform.
    if (entry.streamTransform) {
      try {
        const transformed = await entry.streamTransform(this.toStreamUser(user), item);
        if (transformed === undefined) return undefined;
        item = transformed;
      } catch (e) {
        this.logger.warn(`streamTransform for ${entry.name} threw: ${e?.message || e}`);
        return undefined;
      }
    }

    const id = String(raw._doc?._id ?? raw._doc?.id ?? '');
    const updatedAt: Date = raw._doc?.updatedAt instanceof Date ? raw._doc.updatedAt : new Date();

    return {
      cursor: id ? this.encodeCursor({ id, updatedAt }) : undefined,
      id,
      item,
      model: raw.model,
      op: raw.op,
      version: raw._doc?.version,
    };
  }

  /**
   * Returns the catch-up snapshot for a subscriber that re-connects with
   * a stored cursor. Reuses the model's `findChangesSince` and routes
   * each result through the same security pipeline as live events.
   *
   * Caller (resolver) is expected to emit each event with `op: 'snapshot'`
   * and a final `op: 'snapshot-complete'` terminator before switching to
   * the live stream.
   */
  async getCatchupEvents(
    modelName: string,
    sinceCursor: string | null | undefined,
    user: any,
  ): Promise<ISyncStreamEvent[]> {
    const entry = this.requireEntry(modelName);
    if (!entry.streamEnabled) return [];

    const cfg = this.getConfig();
    const max = cfg?.stream?.maxCatchupItems ?? 1000;
    const cursor = sinceCursor ? this.decodeCursor(sinceCursor) : null;

    const result = await entry.service.findChangesSince(cursor, {
      lean: false,
      limit: max,
      serviceOptions: { currentUser: user },
    });

    const events: ISyncStreamEvent[] = [];
    for (const doc of result.changes) {
      const op: 'created' | 'updated' | 'deleted' = doc.deletedAt
        ? 'deleted'
        : (doc.version === 1 ? 'created' : 'updated');
      const matches = await this.streamFilterMatches(
        { syncStreamRaw: { _doc: doc, _tenantId: doc?.tenantId, model: modelName, op } },
        { model: modelName },
        user,
      );
      if (!matches) continue;
      const event = await this.transformStreamPayload(
        { syncStreamRaw: { _doc: doc, _tenantId: doc?.tenantId, model: modelName, op } },
        user,
      );
      if (!event) continue;
      events.push({ ...event, op: 'snapshot' });
    }
    return events;
  }

  /**
   * Recursive secret removal — defensive duplicate of CheckSecurityInterceptor's
   * logic for the WebSocket pipeline (interceptors do not run on subs).
   */
  protected removeSecrets(data: any): void {
    if (!data || typeof data !== 'object') return;
    const secretFields: string[] =
      ConfigService.get('security.secretFields') ||
      ['password', 'verificationToken', 'passwordResetToken', 'refreshTokens', 'tempTokens'];
    if (Array.isArray(data)) {
      for (const item of data) this.removeSecrets(item);
      return;
    }
    for (const field of secretFields) {
      if (field in data) delete data[field];
    }
    for (const key of Object.keys(data)) {
      if (data[key] && typeof data[key] === 'object') {
        this.removeSecrets(data[key]);
      }
    }
  }

  protected isStreamEnabled(): boolean {
    const cfg = this.getConfig()?.stream;
    if (cfg === false) return false;
    if (cfg === true || cfg === undefined) return true;
    return cfg?.enabled !== false;
  }

  protected getStreamChannel(): string {
    const cfg = this.getConfig()?.stream;
    if (cfg && typeof cfg === 'object' && cfg.channel) return cfg.channel;
    return 'syncStream';
  }

  /**
   * Maximum number of concurrent stream subscriptions allowed per user.
   */
  getMaxStreamSubscriptionsPerUser(): number {
    const cfg = this.getConfig()?.stream;
    if (cfg && typeof cfg === 'object' && typeof cfg.maxSubscriptionsPerUser === 'number') {
      return cfg.maxSubscriptionsPerUser;
    }
    return 5;
  }

  /**
   * Encodes a cursor as a URL-safe opaque string.
   */
  encodeCursor(cursor: { updatedAt: Date; id: string }): string {
    return Buffer.from(JSON.stringify({ i: cursor.id, u: cursor.updatedAt.toISOString() })).toString('base64url');
  }

  /**
   * Decodes a cursor from its opaque string form. Returns null on empty input.
   */
  decodeCursor(encoded?: string | null): { updatedAt: Date; id: string } | null {
    if (!encoded) return null;
    try {
      const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString());
      if (!parsed?.u || !parsed?.i) return null;
      return { id: String(parsed.i), updatedAt: new Date(parsed.u) };
    } catch {
      throw new BadRequestException('Invalid cursor');
    }
  }

  /**
   * Whether the sync registry contains the given model.
   */
  hasModel(name: string): boolean {
    return !!this.registry.get(name);
  }

  /**
   * Return all registered model names (for diagnostics and tests).
   */
  listModels(): string[] {
    return this.registry.list().map((e) => e.name);
  }

  // ====================================================================
  // Internal helpers
  // ====================================================================

  protected requireEntry(modelName: string): ISyncRegistryEntry {
    const entry = this.registry.get(modelName);
    if (!entry || !entry.service) {
      throw new NotFoundException(`Sync model "${modelName}" is not registered`);
    }
    return entry;
  }

  protected stripSyncMeta(data: Record<string, any>): Record<string, any> {
    const cleaned = { ...data };
    delete (cleaned as any).version;
    delete (cleaned as any).deletedAt;
    delete (cleaned as any).id;
    delete (cleaned as any)._id;
    delete (cleaned as any).__v;
    delete (cleaned as any).createdAt;
    delete (cleaned as any).updatedAt;
    return cleaned;
  }

  protected docId(doc: any): string | undefined {
    return doc?.id ?? doc?._id?.toString();
  }

  protected getConfig(): any {
    return ConfigService.get('sync') ?? {};
  }

  protected isHintEnabled(): boolean {
    const hint = this.getConfig()?.hint;
    if (hint === false) return false;
    if (hint === true || hint === undefined) return true;
    return hint?.enabled !== false;
  }

  protected getHintDebounceMs(): number {
    const hint = this.getConfig()?.hint;
    if (hint && typeof hint === 'object') return hint.debounceMs ?? 250;
    return 250;
  }

  protected isIdempotencyEnabled(): boolean {
    const idem = this.getConfig()?.idempotency;
    if (idem === false) return false;
    if (idem === undefined) return true;
    return idem?.enabled !== false;
  }

  protected async lookupIdempotencyKeys(
    modelName: string,
    items: ISyncPushItem[],
    userId?: string,
  ): Promise<Map<string, ISyncPushResult>> {
    const map = new Map<string, ISyncPushResult>();
    if (!this.idempotencyModel || !userId) return map;
    const clientIds = items.map((i) => i.clientId).filter(Boolean) as string[];
    if (!clientIds.length) return map;
    try {
      const cached = await this.idempotencyModel
        .find({ clientId: { $in: clientIds }, modelName, userId })
        .lean()
        .exec();
      for (const c of cached) {
        if (c.expiresAt && new Date(c.expiresAt) < new Date()) continue;
        map.set(c.clientId, c.result);
      }
    } catch (e) {
      this.logger.warn(`Idempotency lookup failed: ${e?.message || e}`);
    }
    return map;
  }

  protected async storeIdempotency(
    modelName: string,
    clientId: string,
    userId: string | undefined,
    result: ISyncPushResult,
  ): Promise<void> {
    if (!this.idempotencyModel || !userId) return;
    try {
      const ttl = this.getConfig()?.idempotency?.ttlSeconds ?? 86400;
      await this.idempotencyModel.findOneAndUpdate(
        { clientId, modelName, userId },
        { $set: { expiresAt: new Date(Date.now() + ttl * 1000), result } },
        { upsert: true },
      );
    } catch (e) {
      this.logger.warn(`Idempotency store failed: ${e?.message || e}`);
    }
  }
}
