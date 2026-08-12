import { HttpException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LegacyAuthRateLimiter } from '../../src/core/modules/auth/services/legacy-auth-rate-limiter.service';
import { CoreBetterAuthEmailVerificationService } from '../../src/core/modules/better-auth/core-better-auth-email-verification.service';
import { CoreBetterAuthRateLimiter } from '../../src/core/modules/better-auth/core-better-auth-rate-limiter.service';
import { CoreAiService } from '../../src/core/modules/ai/services/core-ai.service';
import { CoreAiPromptBuilderService } from '../../src/core/modules/ai/services/core-ai-prompt-builder.service';
import { ConfigService } from '../../src/core/common/services/config.service';
import { InMemoryRateLimitStore, RedisRateLimitStore } from '../../src/core/common/services/rate-limit-store';

import type { CoreRedisService } from '../../src/core/common/services/core-redis.service';

/**
 * Minimal fake ioredis client covering the surface the stores and the email
 * cooldown use.
 */
function createFakeRedis() {
  const store = new Map<string, unknown>();
  return {
    del: vi.fn(async (...keys: string[]) => {
      keys.forEach(key => store.delete(key));
      return keys.length;
    }),
    eval: vi.fn(async (script: string, numKeys: number, ...rest: unknown[]) => {
      // Two different scripts share this fake: the rate-limit hit counter, and the cooldown's
      // compare-and-delete. Dispatch on the script so the release actually frees the key —
      // otherwise the test cannot tell a correct release from one that did nothing.
      const keys = rest.slice(0, numKeys) as string[];
      const args = rest.slice(numKeys);
      if (script.includes('DEL')) {
        if (store.get(keys[0]) !== args[0]) {
          return 0;
        }
        store.delete(keys[0]);
        return 1;
      }
      // Hit script: KEYS = [counter, cardinality, overflow], ARGV = [window, maxKeys].
      const [key, cardinalityKey, overflowKey] = keys;
      let target = key;
      let overflow = 0;
      if (!store.has(key)) {
        const seen = ((store.get(cardinalityKey) as number) ?? 0) + 1;
        store.set(cardinalityKey, seen);
        if (seen > Number(args[1])) {
          target = overflowKey;
          overflow = 1;
        }
      }
      const count = ((store.get(target) as number) ?? 0) + 1;
      store.set(target, count);
      return [count, Number(args[0]), overflow];
    }),
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
      const regex = new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`);
      return ['0', [...store.keys()].filter(key => regex.test(key))];
    }),
    set: vi.fn(async (key: string, value?: unknown) => {
      if (store.has(key)) {
        return null;
      }
      // Keep the VALUE, not a placeholder — the cooldown's compare-and-delete is only meaningful
      // if the fake remembers which token holds the key.
      store.set(key, value ?? 1);
      return 'OK';
    }),
    store,
  };
}

function createRedisService(enabled: boolean) {
  const client = createFakeRedis();
  const redisService = {
    enabled,
    getClient: () => client,
    key: (...parts: string[]) => ['test-prefix', ...parts].join(':'),
  } as unknown as CoreRedisService;
  return { client, redisService };
}

describe('CoreBetterAuthRateLimiter store selection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the in-memory store when no Redis service is injected', async () => {
    const limiter = new CoreBetterAuthRateLimiter();
    limiter.configure({ enabled: true, max: 4, strictEndpoints: [], windowSeconds: 60 });

    expect(await limiter.check('1.2.3.4', '/profile')).toMatchObject({ allowed: true, current: 1, remaining: 3 });
    expect((await limiter.check('1.2.3.4', '/profile')).current).toBe(2);
    expect(limiter.getStats().activeEntries).toBe(1);

    limiter.onModuleDestroy();
  });

  it('uses the in-memory store when the injected Redis service is disabled', async () => {
    const { redisService } = createRedisService(false);
    const limiter = new CoreBetterAuthRateLimiter(redisService);
    limiter.configure({ enabled: true, max: 4, windowSeconds: 60 });

    await limiter.check('1.2.3.4', '/profile');
    expect(limiter['getStore']()).toBeInstanceOf(InMemoryRateLimitStore);

    limiter.onModuleDestroy();
  });

  it('uses the Redis store when the injected Redis service is enabled', async () => {
    const { client, redisService } = createRedisService(true);
    const limiter = new CoreBetterAuthRateLimiter(redisService);
    limiter.configure({ enabled: true, max: 4, strictEndpoints: [], windowSeconds: 60 });

    expect(limiter['getStore']()).toBeInstanceOf(RedisRateLimitStore);
    expect(await limiter.check('1.2.3.4', '/profile')).toMatchObject({ allowed: true, current: 1, remaining: 3 });
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('INCR'),
      3,
      'test-prefix:rate-limit:better-auth:1.2.3.4:profile',
      'test-prefix:rate-limit:better-auth:#meta:cardinality',
      expect.stringContaining('test-prefix:rate-limit:better-auth:#overflow:'),
      60,
      expect.any(Number),
    );

    // getStats cannot count Redis entries cheaply
    expect(limiter.getStats().activeEntries).toBe(-1);
  });

  it('resets a single IP via the Redis store', async () => {
    const { client, redisService } = createRedisService(true);
    const limiter = new CoreBetterAuthRateLimiter(redisService);
    limiter.configure({ enabled: true, max: 4, windowSeconds: 60 });

    await limiter.check('1.2.3.4', '/profile');
    await limiter.check('5.6.7.8', '/profile');
    await limiter.reset('1.2.3.4');

    // `#meta:cardinality` is the framework's own keyspace bound and outlives a per-IP reset by
    // design — resetting one client must not double as a way to clear the cap.
    expect([...client.store.keys()]).toEqual([
      'test-prefix:rate-limit:better-auth:#meta:cardinality',
      'test-prefix:rate-limit:better-auth:5.6.7.8:profile',
    ]);
  });
});

describe('LegacyAuthRateLimiter store selection', () => {
  it('uses the in-memory store without Redis', async () => {
    const limiter = new LegacyAuthRateLimiter();
    limiter.configure({ enabled: true, max: 2, windowSeconds: 60 });

    expect(await limiter.check('1.2.3.4', 'signIn')).toMatchObject({ allowed: true, current: 1, remaining: 1 });
    expect((await limiter.check('1.2.3.4', 'signIn')).allowed).toBe(true);
    expect((await limiter.check('1.2.3.4', 'signIn')).allowed).toBe(false);
    expect(limiter['getStore']()).toBeInstanceOf(InMemoryRateLimitStore);

    limiter.onModuleDestroy();
  });

  it('uses the Redis store when Redis is enabled', async () => {
    const { client, redisService } = createRedisService(true);
    const limiter = new LegacyAuthRateLimiter(redisService);
    limiter.configure({ enabled: true, max: 2, windowSeconds: 60 });

    expect(limiter['getStore']()).toBeInstanceOf(RedisRateLimitStore);
    await limiter.check('1.2.3.4', 'signIn');
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('INCR'),
      3,
      'test-prefix:rate-limit:legacy-auth:1.2.3.4:signIn',
      'test-prefix:rate-limit:legacy-auth:#meta:cardinality',
      expect.stringContaining('test-prefix:rate-limit:legacy-auth:#overflow:'),
      60,
      expect.any(Number),
    );
  });
});

describe('CoreAiService rate limit store', () => {
  function createAiService(redisService?: CoreRedisService) {
    return new CoreAiService(
      {} as any,
      {} as any,
      {} as any,
      new CoreAiPromptBuilderService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      redisService,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enforces the configured limit with the in-memory store', async () => {
    vi.spyOn(ConfigService, 'get').mockReturnValue({ max: 2, windowSeconds: 60 } as any);
    const service = createAiService() as any;

    await service.checkRateLimit('user-1');
    await service.checkRateLimit('user-1');
    await expect(service.checkRateLimit('user-1')).rejects.toBeInstanceOf(HttpException);
    // Other users are tracked independently
    await expect(service.checkRateLimit('user-2')).resolves.toBeUndefined();
    expect(service.getRateLimitStore()).toBeInstanceOf(InMemoryRateLimitStore);
  });

  it('uses the Redis store when Redis is enabled', async () => {
    vi.spyOn(ConfigService, 'get').mockReturnValue({ max: 2, windowSeconds: 30 } as any);
    const { client, redisService } = createRedisService(true);
    const service = createAiService(redisService) as any;

    await service.checkRateLimit('user-1');
    expect(service.getRateLimitStore()).toBeInstanceOf(RedisRateLimitStore);
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('INCR'),
      3,
      'test-prefix:rate-limit:ai:user-1',
      'test-prefix:rate-limit:ai:#meta:cardinality',
      expect.stringContaining('test-prefix:rate-limit:ai:#overflow:'),
      30,
      expect.any(Number),
    );
  });

  it('skips rate limiting when ai.rateLimit is absent', async () => {
    vi.spyOn(ConfigService, 'get').mockReturnValue(undefined as any);
    const service = createAiService() as any;

    for (let i = 0; i < 50; i++) {
      await expect(service.checkRateLimit('user-1')).resolves.toBeUndefined();
    }
  });
});

describe('CoreBetterAuthEmailVerificationService send slot', () => {
  function createService(resendCooldownSeconds: number, redisService?: CoreRedisService) {
    const configService = {
      getFastButReadOnly: (key: string) =>
        key === 'betterAuth.emailVerification' ? { resendCooldownSeconds } : undefined,
    } as any;
    return new CoreBetterAuthEmailVerificationService(
      configService,
      undefined,
      undefined,
      undefined,
      redisService,
    ) as any;
  }

  it('acquires once and blocks the second attempt in memory', async () => {
    const service = createService(60);

    expect(await service.acquireSendSlot('User@Test.com')).toBeTruthy();
    expect(await service.acquireSendSlot('user@test.com')).toBeNull();
  });

  it('releases the slot so a failed send does not burn the cooldown', async () => {
    const service = createService(60);

    const slot = await service.acquireSendSlot('user@test.com');
    expect(slot).toBeTruthy();
    await service.releaseSendSlot('user@test.com', slot);
    expect(await service.acquireSendSlot('user@test.com')).toBeTruthy();
  });

  it('never blocks when the cooldown is disabled', async () => {
    const service = createService(0);

    expect(await service.acquireSendSlot('user@test.com')).toBeTruthy();
    expect(await service.acquireSendSlot('user@test.com')).toBeTruthy();
    expect(service.isInCooldown('user@test.com')).toBe(false);
  });

  it('reserves the slot atomically via Redis SET NX PX', async () => {
    const { client, redisService } = createRedisService(true);
    const service = createService(60, redisService);

    const token = await service.acquireSendSlot('User@Test.com');
    expect(token).toBeTruthy();
    expect(client.set).toHaveBeenCalledWith(
      'test-prefix:email-verification-cooldown:user@test.com',
      token,
      'PX',
      60000,
      'NX',
    );

    expect(await service.acquireSendSlot('user@test.com')).toBeNull();

    // Release is a compare-and-delete against the acquired token, never a bare DEL: a send can
    // fail slower than the cooldown, and by then the key belongs to a LATER request.
    await service.releaseSendSlot('user@test.com', token);
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('DEL'),
      1,
      'test-prefix:email-verification-cooldown:user@test.com',
      token,
    );
    expect(client.del).not.toHaveBeenCalled();
    expect(await service.acquireSendSlot('user@test.com')).toBeTruthy();
  });

  it('releases the slot when the send throws', async () => {
    const service = createService(60);
    service.emailService = { sendMail: vi.fn(async () => { throw new Error('smtp down'); }) };

    await expect(
      service.sendVerificationEmail({ token: 't', url: 'https://example.com', user: { email: 'fail@test.com', id: '1' } }),
    ).rejects.toThrow('smtp down');

    // Cooldown was not burnt — a retry is allowed immediately
    expect(await service.acquireSendSlot('fail@test.com')).toBeTruthy();
  });

  it('burns the cooldown on a successful send', async () => {
    const service = createService(60);
    service.emailService = { sendMail: vi.fn(async () => undefined) };

    await service.sendVerificationEmail({
      token: 't',
      url: 'https://example.com',
      user: { email: 'ok@test.com', id: '1' },
    });

    expect(await service.acquireSendSlot('ok@test.com')).toBeNull();
  });
});
