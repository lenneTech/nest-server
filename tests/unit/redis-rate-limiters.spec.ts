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
  const store = new Map<string, number>();
  return {
    del: vi.fn(async (...keys: string[]) => {
      keys.forEach(key => store.delete(key));
      return keys.length;
    }),
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, windowSeconds: number) => {
      const count = (store.get(key) ?? 0) + 1;
      store.set(key, count);
      return [count, Number(windowSeconds)];
    }),
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
      const regex = new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`);
      return ['0', [...store.keys()].filter(key => regex.test(key))];
    }),
    set: vi.fn(async (key: string) => {
      if (store.has(key)) {
        return null;
      }
      store.set(key, 1);
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
      1,
      'test-prefix:rate-limit:better-auth:1.2.3.4:profile',
      60,
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

    expect([...client.store.keys()]).toEqual(['test-prefix:rate-limit:better-auth:5.6.7.8:profile']);
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
      1,
      'test-prefix:rate-limit:legacy-auth:1.2.3.4:signIn',
      60,
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
      1,
      'test-prefix:rate-limit:ai:user-1',
      30,
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

    expect(await service.acquireSendSlot('User@Test.com')).toBe(true);
    expect(await service.acquireSendSlot('user@test.com')).toBe(false);
  });

  it('releases the slot so a failed send does not burn the cooldown', async () => {
    const service = createService(60);

    expect(await service.acquireSendSlot('user@test.com')).toBe(true);
    await service.releaseSendSlot('user@test.com');
    expect(await service.acquireSendSlot('user@test.com')).toBe(true);
  });

  it('never blocks when the cooldown is disabled', async () => {
    const service = createService(0);

    expect(await service.acquireSendSlot('user@test.com')).toBe(true);
    expect(await service.acquireSendSlot('user@test.com')).toBe(true);
    expect(service.isInCooldown('user@test.com')).toBe(false);
  });

  it('reserves the slot atomically via Redis SET NX PX', async () => {
    const { client, redisService } = createRedisService(true);
    const service = createService(60, redisService);

    expect(await service.acquireSendSlot('User@Test.com')).toBe(true);
    expect(client.set).toHaveBeenCalledWith(
      'test-prefix:email-verification-cooldown:user@test.com',
      '1',
      'PX',
      60000,
      'NX',
    );

    expect(await service.acquireSendSlot('user@test.com')).toBe(false);

    await service.releaseSendSlot('user@test.com');
    expect(client.del).toHaveBeenCalledWith('test-prefix:email-verification-cooldown:user@test.com');
    expect(await service.acquireSendSlot('user@test.com')).toBe(true);
  });

  it('releases the slot when the send throws', async () => {
    const service = createService(60);
    service.emailService = { sendMail: vi.fn(async () => { throw new Error('smtp down'); }) };

    await expect(
      service.sendVerificationEmail({ token: 't', url: 'https://example.com', user: { email: 'fail@test.com', id: '1' } }),
    ).rejects.toThrow('smtp down');

    // Cooldown was not burnt — a retry is allowed immediately
    expect(await service.acquireSendSlot('fail@test.com')).toBe(true);
  });

  it('burns the cooldown on a successful send', async () => {
    const service = createService(60);
    service.emailService = { sendMail: vi.fn(async () => undefined) };

    await service.sendVerificationEmail({
      token: 't',
      url: 'https://example.com',
      user: { email: 'ok@test.com', id: '1' },
    });

    expect(await service.acquireSendSlot('ok@test.com')).toBe(false);
  });
});
