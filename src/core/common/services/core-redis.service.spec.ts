import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getProjectSlug } from '../helpers/project-name.helper';
import { CoreRedisService } from './core-redis.service';

import type { ConfigService } from './config.service';

/**
 * Shared handles into the mocked ioredis client. `vi.hoisted` runs before the
 * `vi.mock` factory below, so the spies exist when the module graph is wired up.
 */
const redisMock = vi.hoisted(() => ({
  /** Every constructor argument list, in call order. */
  constructorArgs: [] as unknown[][],
  instances: [] as any[],
  quit: vi.fn().mockResolvedValue('OK'),
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    handlers = new Map<string, (...args: unknown[]) => void>();
    quit = redisMock.quit;
    constructor(...args: unknown[]) {
      redisMock.constructorArgs.push(args);
      redisMock.instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      this.handlers.set(event, handler);
      return this;
    }
  }
  return { Redis: FakeRedis, default: FakeRedis };
});

function createService(redisConfig: unknown): CoreRedisService {
  const configService = {
    getFastButReadOnly: (key: string, defaultValue?: unknown) => (key === 'redis' ? redisConfig : defaultValue),
  } as unknown as ConfigService;
  return new CoreRedisService(configService);
}

describe('CoreRedisService', () => {
  describe('key prefix default', () => {
    it('namespaces per APPLICATION, not per framework', () => {
      // The old default was the constant 'nest-server' for every project. That is invisible until
      // two applications share one Redis — a normal staging setup — and then their identically
      // named cron jobs, rate-limit counters and Hub buffers collide silently: one app's worker
      // consumes the other's scheduled jobs, so the job never runs where it was defined.
      const service = createService({});

      const prefix = service.getConfig()?.keyPrefix;
      expect(prefix).toBeTruthy();
      expect(prefix).toBe(getProjectSlug());
      expect(service.key('cron-lock', 'cleanup')).toBe(`${getProjectSlug()}:cron-lock:cleanup`);
    });

    it('still honors an explicit keyPrefix — sharing stays possible when it is intended', () => {
      const service = createService({ keyPrefix: 'shared-ns' });
      expect(service.getConfig()?.keyPrefix).toBe('shared-ns');
      expect(service.key('rate-limit', 'ip')).toBe('shared-ns:rate-limit:ip');
    });
  });
  beforeEach(() => {
    redisMock.constructorArgs.length = 0;
    redisMock.instances.length = 0;
    redisMock.quit.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('presence implies enabled', () => {
    it('is disabled without config', () => {
      expect(createService(undefined).enabled).toBe(false);
      expect(createService(null).enabled).toBe(false);
    });

    it('is enabled via boolean shorthand true', () => {
      expect(createService(true).enabled).toBe(true);
    });

    it('is disabled via boolean shorthand false', () => {
      expect(createService(false).enabled).toBe(false);
    });

    it('is enabled via empty object', () => {
      expect(createService({}).enabled).toBe(true);
    });

    it('is disabled via explicit enabled: false despite other options', () => {
      expect(createService({ enabled: false, host: 'redis.internal' }).enabled).toBe(false);
    });
  });

  describe('config normalization', () => {
    it('applies defaults for boolean shorthand', () => {
      const service = createService(true);
      // keyPrefix is per-application now (see the "key prefix default" block), so assert the
      // contract rather than a literal that would silently re-pin the old shared constant.
      expect(service.getConfig()).toMatchObject({ db: 0, host: 'localhost', keyPrefix: getProjectSlug(), port: 6379 });
    });

    it('keeps explicit values and fills the rest', () => {
      const service = createService({ host: 'redis.internal', keyPrefix: 'myapp', port: 6380 });
      expect(service.getConfig()).toMatchObject({ db: 0, host: 'redis.internal', keyPrefix: 'myapp', port: 6380 });
    });
  });

  describe('key()', () => {
    it('prefixes keys with the configured prefix', () => {
      expect(createService(true).key('rate-limit', 'auth', '1.2.3.4')).toBe(
        `${getProjectSlug()}:rate-limit:auth:1.2.3.4`,
      );
      expect(createService({ keyPrefix: 'myapp' }).key('lock')).toBe('myapp:lock');
    });
  });

  describe('client lifecycle', () => {
    it('getClient() throws a helpful error when Redis is not enabled', () => {
      expect(() => createService(undefined).getClient()).toThrow(/not (configured|enabled)/i);
    });

    it('getClient() throws before init', () => {
      expect(() => createService(true).getClient()).toThrow(/init/i);
    });

    it('creates a shared client on init and returns the same instance', async () => {
      const service = createService(true);
      await service.onModuleInit();
      const a = service.getClient();
      const b = service.getClient();
      expect(a).toBe(b);
      expect(redisMock.constructorArgs.length).toBe(1);
      expect(redisMock.constructorArgs[0][0]).toMatchObject({ db: 0, host: 'localhost', port: 6379 });
    });

    it('uses the url when provided', async () => {
      const service = createService({ url: 'redis://user:pass@redis.internal:6390/2' });
      await service.onModuleInit();
      service.getClient();
      expect(redisMock.constructorArgs[0][0]).toBe('redis://user:pass@redis.internal:6390/2');
    });

    it('passes through additional ioredis options', async () => {
      const service = createService({ options: { retryStrategy: null } });
      await service.onModuleInit();
      service.getClient();
      expect(redisMock.constructorArgs[0][0]).toMatchObject({ retryStrategy: null });
    });

    it('createClient() returns a new connection per call', async () => {
      const service = createService(true);
      await service.onModuleInit();
      const shared = service.getClient();
      const extra = service.createClient('bullmq');
      expect(extra).not.toBe(shared);
      expect(redisMock.constructorArgs.length).toBe(2);
    });

    it('getSubscriber() returns a dedicated cached connection', async () => {
      const service = createService(true);
      await service.onModuleInit();
      const sub1 = service.getSubscriber();
      const sub2 = service.getSubscriber();
      expect(sub1).toBe(sub2);
      expect(sub1).not.toBe(service.getClient());
    });

    it('init without config is a no-op and creates no client', async () => {
      const service = createService(undefined);
      await service.onModuleInit();
      expect(redisMock.constructorArgs.length).toBe(0);
    });

    it('quits every created client on shutdown', async () => {
      const service = createService(true);
      await service.onModuleInit();
      service.getClient();
      service.getSubscriber();
      service.createClient('extra');
      await service.onApplicationShutdown();
      expect(redisMock.quit).toHaveBeenCalledTimes(3);
    });
  });

  describe('connection errors', () => {
    it('logs a connection error instead of crashing the process', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const service = createService(true);
      await service.onModuleInit();
      service.getClient();

      const handler = redisMock.instances[0].handlers.get('error');
      expect(handler).toBeDefined();
      // ioredis emits 'error' on every failed reconnect — an unhandled throw here
      // would take the whole process down.
      expect(() => handler(new Error('ECONNREFUSED'))).not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('shared'));
    });
  });

  describe('missing ioredis package', () => {
    afterEach(() => {
      vi.doUnmock('ioredis');
      vi.resetModules();
    });

    it('onModuleInit() rejects with an actionable error naming the package and install command', async () => {
      vi.resetModules();
      vi.doMock('ioredis', () => {
        throw new Error("Cannot find module 'ioredis'");
      });
      const { CoreRedisService: FreshService } = await import('./core-redis.service');
      const service = new FreshService({
        getFastButReadOnly: (key: string) => (key === 'redis' ? true : undefined),
      } as unknown as ConfigService);

      await expect(service.onModuleInit()).rejects.toThrow(/ioredis/);
      await expect(service.onModuleInit()).rejects.toThrow(/pnpm add ioredis/);
    });
  });
});
