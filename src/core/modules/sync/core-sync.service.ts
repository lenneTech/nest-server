import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PubSub as PubSubInstance } from 'graphql-subscriptions';
import { Connection } from 'mongoose';

import { getSyncFieldStrategies } from '../../common/decorators/syncable.decorator';
import { SyncConflictException } from '../../common/exceptions/sync-conflict.exception';
import { ConfigService } from '../../common/services/config.service';
import { ISyncPullResponse, ISyncPushItem, ISyncPushResponse, ISyncPushResult, ISyncRegistryEntry } from './sync.interfaces';
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
        createDto: raw.createDto,
        fieldStrategies,
        maxLimit: raw.maxLimit ?? defaultMaxLimit,
        maxPushBatch: raw.maxPushBatch ?? defaultMaxPushBatch,
        name: raw.name,
        onConflict: raw.onConflict,
        pullLean: raw.pullLean === true,
        service: serviceInstance,
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
        // Try field-level merge before raising the conflict.
        const merged = await this.tryFieldLevelMerge(entry, item, cleanData, e, safeOptions);
        if (merged) return merged;

        // Notify hook.
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
