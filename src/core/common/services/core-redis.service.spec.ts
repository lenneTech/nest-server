import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    quit = redisMock.quit;
    constructor(...args: unknown[]) {
      redisMock.constructorArgs.push(args);
      redisMock.instances.push(this);
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
      expect(service.getConfig()).toMatchObject({ db: 0, host: 'localhost', keyPrefix: 'nest-server', port: 6379 });
    });

    it('keeps explicit values and fills the rest', () => {
      const service = createService({ host: 'redis.internal', keyPrefix: 'myapp', port: 6380 });
      expect(service.getConfig()).toMatchObject({ db: 0, host: 'redis.internal', keyPrefix: 'myapp', port: 6380 });
    });
  });

  describe('key()', () => {
    it('prefixes keys with the configured prefix', () => {
      expect(createService(true).key('rate-limit', 'auth', '1.2.3.4')).toBe('nest-server:rate-limit:auth:1.2.3.4');
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
});
