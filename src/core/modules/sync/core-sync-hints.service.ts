import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { ISync } from '../../common/interfaces/server-options.interface.js';
import { ConfigService } from '../../common/services/config.service.js';
import { CoreRedisService } from '../../common/services/core-redis.service.js';
import { SYNC_DEFAULTS } from './core-sync.constants.js';

/**
 * A hint as the bus carries it: a synchronized model changed, in a tenant (`undefined` on a model without tenants).
 * Subscribers receive `{ model, at }` only (plan §3.9); the tenant decides who receives it.
 */
export interface SyncHintEvent {
  at: number;
  model: string;
  tenantId?: string;
}

/**
 * The hint bus of offline sync (plan §3.9, protocol §9): a change of a synchronized model becomes one hint per model and
 * tenant per `sync.hints.debounceMs`, delivered to this replica's subscribers at once and, with `redis`, to every other
 * replica's through one Redis channel. Without Redis, or while it does not answer, hints stay on this replica — a hint
 * only means "pull now", so a client that misses one learns of the change at its next pull.
 *
 * Who may receive a hint is not decided here: each subscriber filters by its own access (`CoreSyncService`).
 */
@Injectable()
export class CoreSyncHintService implements OnApplicationBootstrap, OnModuleDestroy {
  protected readonly logger = new Logger(CoreSyncHintService.name);
  /** This replica, so a hint it published is not delivered a second time when Redis brings it back */
  protected readonly origin = randomUUID();
  protected readonly subscribers = new Set<(hint: SyncHintEvent) => void>();
  /** Pending hints by model and tenant: one per key and debounce window, removed when sent */
  protected readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  protected channel?: string;
  protected redisListener?: (channel: string, message: string) => void;

  constructor(@Optional() protected readonly redisService?: CoreRedisService) {}

  /** The `sync.hints` configuration (an object; `true` / absent read as `{}`, `false` as `{ enabled: false }`) */
  protected get config(): Exclude<ISync['hints'], boolean | undefined> {
    const sync = ConfigService.configFastButReadOnly?.sync;
    const hints = sync && typeof sync === 'object' ? sync.hints : undefined;
    if (hints === false) {
      return { enabled: false };
    }
    return hints && typeof hints === 'object' ? hints : {};
  }

  /** Whether hints are sent at all (`sync.hints`, on by default) */
  get enabled(): boolean {
    return this.config.enabled !== false;
  }

  /** `sync.hints.debounceMs`: at most one hint per model and tenant per window; an invalid value → the default */
  protected get debounceMs(): number {
    const value = this.config.debounceMs;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : SYNC_DEFAULTS.hintDebounceMs;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled || !this.redisService?.enabled) {
      return;
    }
    const channel = this.redisService.key('sync', 'hints');
    try {
      // Held in a field: the subscriber connection is shared, a listener left behind would deliver into a destroyed bus
      this.channel = channel;
      this.redisListener = (incoming: string, message: string) => {
        if (incoming === channel) {
          this.receive(message);
        }
      };
      this.redisService.getSubscriber().on('message', this.redisListener);
      // Registered with the Redis service, so the subscription comes back after every reconnect
      await this.redisService.subscribeChannel(channel);
    } catch (error) {
      this.logger.warn(
        `Sync hints: Redis subscribe failed (${(error as Error)?.message ?? error}) — retried when the connection is ` +
          "up; until then this replica's subscribers receive only its own hints",
      );
    }
  }

  onModuleDestroy(): void {
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    this.subscribers.clear();
    if (this.redisListener) {
      try {
        this.redisService?.getSubscriber().off('message', this.redisListener);
        if (this.channel) {
          void this.redisService?.releaseChannel(this.channel).catch(() => undefined);
        }
      } catch {
        // Redis already gone — nothing to detach from
      }
      this.redisListener = undefined;
    }
  }

  /**
   * A synchronized model changed in these tenants (none: a model without tenants). Sent as one hint per model and
   * tenant once the debounce window ends — a burst of writes is one hint.
   */
  notify(model: string, tenantIds: readonly (string | undefined)[] = [undefined]): void {
    if (!this.enabled) {
      return;
    }
    for (const tenantId of tenantIds.length ? new Set(tenantIds) : [undefined]) {
      const key = `${model}\u0000${tenantId ?? ''}`;
      if (this.pending.has(key)) {
        continue;
      }
      const timer = setTimeout(() => {
        this.pending.delete(key);
        this.send({ at: Date.now(), model, ...(tenantId ? { tenantId } : {}) });
      }, this.debounceMs);
      timer.unref?.();
      this.pending.set(key, timer);
    }
  }

  /** Receive every hint (this replica's and, with Redis, every other's); answers the unsubscribe */
  subscribe(handler: (hint: SyncHintEvent) => void): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /** Deliver a hint here and hand it to the other replicas */
  protected send(hint: SyncHintEvent): void {
    this.deliver(hint);
    if (!this.channel || !this.redisService?.enabled) {
      return;
    }
    try {
      void this.redisService
        .getClient()
        .publish(this.channel, JSON.stringify({ ...hint, origin: this.origin }))
        .catch((error: Error) => this.logger.debug(`Sync hint publish failed: ${error.message}`));
    } catch (error) {
      this.logger.debug(`Sync hint publish failed: ${(error as Error)?.message ?? error}`);
    }
  }

  /** A hint from the Redis channel — another replica's; this replica's own were delivered when sent */
  protected receive(message: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!parsed || parsed.origin === this.origin || typeof parsed.model !== 'string' || !Number.isFinite(parsed.at)) {
      return;
    }
    this.deliver({
      at: Number(parsed.at),
      model: parsed.model,
      ...(typeof parsed.tenantId === 'string' && parsed.tenantId ? { tenantId: parsed.tenantId } : {}),
    });
  }

  protected deliver(hint: SyncHintEvent): void {
    // A Set tolerates a subscriber removing itself while it is called
    for (const handler of this.subscribers) {
      try {
        handler(hint);
      } catch (error) {
        this.logger.warn(`Sync hint subscriber failed: ${(error as Error)?.message ?? error}`);
      }
    }
  }
}
