import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';

import { getProjectSlug } from '../helpers/project-name.helper';
import { ConfigService } from './config.service';

import type { IRedisConfig } from '../interfaces/server-options.interface';
import type { Redis, RedisOptions } from 'ioredis';

/**
 * Fully normalized Redis configuration with all defaults applied
 */
export type NormalizedRedisConfig = Required<Pick<IRedisConfig, 'db' | 'host' | 'keyPrefix' | 'port'>> &
  Pick<IRedisConfig, 'options' | 'password' | 'url' | 'username'>;

/**
 * Central Redis connection service (see IServerOptions.redis).
 *
 * All distributed framework features (rate limiting, cron deduplication, GraphQL
 * subscriptions, caches, Hub collectors) share this single service. It follows the
 * "presence implies enabled" pattern: without a `redis` config every consumer keeps
 * its process-local fallback behavior and this service stays inert.
 *
 * The `ioredis` package is an OPTIONAL peer dependency and is lazy-imported at
 * bootstrap — consumers without Redis never need it installed. When Redis is
 * configured but the package is missing, the boot fails fast with an actionable
 * error instead of a runtime crash on first use.
 */
@Injectable()
export class CoreRedisService implements OnApplicationShutdown, OnModuleInit {
  protected readonly logger = new Logger(CoreRedisService.name);

  /** All connections created by this service, quit together on shutdown */
  protected clients: Redis[] = [];

  /** Normalized config; undefined when Redis is not enabled */
  protected config?: NormalizedRedisConfig;

  /** ioredis constructor, resolved by the lazy import at init */
  protected RedisCtor?: new (...args: any[]) => Redis;

  /** Shared general-purpose client */
  protected sharedClient?: Redis;

  /** Dedicated subscriber connection (a subscribing client cannot run commands) */
  protected subscriberClient?: Redis;

  constructor(protected readonly configService: ConfigService) {
    const raw = this.configService.getFastButReadOnly<boolean | IRedisConfig | undefined>('redis');
    if (raw === undefined || raw === null || raw === false) {
      return;
    }
    const partial: IRedisConfig = typeof raw === 'boolean' ? {} : raw;
    if (partial.enabled === false) {
      return;
    }
    this.config = {
      db: partial.db ?? 0,
      host: partial.host ?? 'localhost',
      // Default namespaced PER APPLICATION, not per framework. A constant default is invisible
      // until two applications share one Redis — a normal staging setup — and then their
      // identically-named cron jobs, rate-limit counters and Hub buffers collide on the same keys.
      // The failure is silent: one app's BullMQ worker consumes the other's scheduled jobs, so the
      // job never runs where it was defined. Override via `redis.keyPrefix` when you WANT sharing.
      keyPrefix: partial.keyPrefix ?? getProjectSlug(),
      options: partial.options,
      password: partial.password,
      port: partial.port ?? 6379,
      url: partial.url,
      username: partial.username,
    };
  }

  /**
   * Whether Redis is configured and enabled
   */
  get enabled(): boolean {
    return !!this.config;
  }

  /**
   * Normalized Redis configuration, or undefined when disabled
   */
  getConfig(): NormalizedRedisConfig | undefined {
    return this.config;
  }

  /**
   * Build a framework-managed Redis key: `<keyPrefix>:<part>:<part>...`
   *
   * The prefix is applied per key instead of via the ioredis `keyPrefix` option,
   * which would conflict with BullMQ's own prefix handling.
   */
  key(...parts: string[]): string {
    return [this.config?.keyPrefix ?? getProjectSlug(), ...parts].join(':');
  }

  /**
   * Lazy-import ioredis and create the shared client.
   * No-op when Redis is not enabled.
   */
  async onModuleInit(): Promise<void> {
    if (!this.config) {
      return;
    }
    try {
      const mod: any = await import('ioredis');
      this.RedisCtor = mod.Redis ?? mod.default;
    } catch {
      throw new Error(
        'Redis is configured (ServerOptions.redis) but the optional peer dependency "ioredis" is not installed. ' +
          'Run: pnpm add ioredis',
      );
    }
    this.sharedClient = this.newConnection('shared');
    this.logActivationSummary();
  }

  /**
   * State the consequences of `redis` being configured, once, at boot.
   *
   * Configuring Redis is not a local decision — it silently changes the behavior of a dozen
   * subsystems at once, and several of those changes are only observable in production. The worst
   * case is a project that never opted in at all: `redis` is a generic name, so a project may
   * already carry that key in its server options for its OWN client, and then a mere version bump
   * flips everything over. Cron stops being per-replica, rate limits get stricter (they were
   * effectively `max × replicas` before), diagnostics leave the process. All correct, none of it
   * announced.
   *
   * So the summary lists what actually changed FOR THIS CONFIG — features that are switched off
   * are omitted rather than listed as inactive, because a list of non-events is noise.
   */
  protected logActivationSummary(): void {
    if (!this.config) {
      return;
    }

    const cfg = this.configService.configFastButReadOnly ?? ({} as Record<string, any>);
    const changed: string[] = [
      'rate limits (legacy auth, better-auth, AI) — now exact across replicas instead of per replica',
      'cron jobs — deduplicated fleet-wide; per-job opt-out via `distributed: false`',
      'email-verification cooldown — one slot fleet-wide instead of one per replica',
    ];

    if (cfg.graphQl !== false) {
      changed.push('GraphQL subscriptions — via Redis pub/sub; payloads must be JSON-serializable');
    }
    if (cfg.multiTenancy) {
      changed.push('tenant-membership cache — invalidation is broadcast to every replica');
    }
    if (cfg.hub) {
      changed.push('Hub log/trace/query buffers — mirrored to Redis, so they outlive the process');
    }
    if (cfg.ai?.mcp) {
      changed.push('MCP sessions — ownership registry (sticky sessions still required)');
    }

    this.logger.log(
      `Redis configured (${this.config.url ? 'url' : `${this.config.host}:${this.config.port}`}, ` +
        `db ${this.config.db}, keyPrefix "${this.config.keyPrefix}") — these subsystems are now ` +
        `distributed:\n  - ${changed.join('\n  - ')}`,
    );
  }

  /**
   * Shared general-purpose client.
   * Throws when Redis is not enabled or the module has not been initialized yet.
   */
  getClient(): Redis {
    if (!this.config) {
      throw new Error('Redis is not configured/enabled (ServerOptions.redis)');
    }
    if (!this.sharedClient) {
      throw new Error('CoreRedisService is not initialized yet (onModuleInit pending)');
    }
    return this.sharedClient;
  }

  /**
   * Dedicated cached subscriber connection — a client in subscribe mode
   * cannot execute regular commands, so it must not share the main connection.
   */
  getSubscriber(): Redis {
    this.getClient();
    if (!this.subscriberClient) {
      this.subscriberClient = this.newConnection('subscriber');
    }
    return this.subscriberClient;
  }

  /**
   * Create a NEW dedicated connection (e.g. for BullMQ, blocking commands).
   * The connection is tracked and closed on application shutdown.
   */
  createClient(label = 'extra', overrides?: RedisOptions): Redis {
    this.getClient();
    return this.newConnection(label, overrides);
  }

  /**
   * Quit all created connections
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(
      this.clients.map(async (client) => {
        try {
          // A client in a reconnect loop QUEUES the quit rather than executing it, so the promise
          // stays pending for the whole retry budget — while the reconnect timer, which is not
          // unref'd, keeps the process alive. Bound the wait and take the socket down either way.
          await Promise.race([client.quit(), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
        } finally {
          client.disconnect();
        }
      }),
    );
    this.clients = [];
    this.sharedClient = undefined;
    this.subscriberClient = undefined;
  }

  /**
   * Create a tracked ioredis connection from the normalized config
   */
  protected newConnection(label: string, overrides?: RedisOptions): Redis {
    if (!this.config || !this.RedisCtor) {
      throw new Error('CoreRedisService is not initialized yet (onModuleInit pending)');
    }
    const { db, host, options, password, port, url, username } = this.config;
    const baseOptions: RedisOptions = {
      // Without a command timeout a command issued while Redis is down neither resolves nor
      // rejects — it waits in the offline queue for the entire retry budget. The rate limiter
      // degrades on a REJECTION, so a blip would stall every sign-in instead of falling back.
      // Listed before the spread so a project's own `redis.options` can still override it.
      commandTimeout: 2000,
      ...(options as RedisOptions),
      // Per-connection opt-out. A BLOCKING consumer (BullMQ's BZPOPMIN waits up to 10s by
      // design) must not inherit the timeout: ioredis would abort the wait, BullMQ would
      // classify it as a real error, and its fetch loop would stop for good.
      ...overrides,
    };
    const client = url
      ? new this.RedisCtor(url, baseOptions)
      : new this.RedisCtor({ db, host, password, port, username, ...baseOptions });
    client.on?.('error', (error: Error) => {
      this.logger.error(`Redis connection error (${label}): ${error.message}`);
    });
    this.clients.push(client);
    return client;
  }
}
