import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerWsConnection } from '../../src/core/common/helpers/graphql-ws-connection.helper';
import { CoreBetterAuthUserMapper } from '../../src/core/modules/better-auth/core-better-auth-user.mapper';

import type { CoreRedisService } from '../../src/core/common/services/core-redis.service';

const CHANNEL = 'app:iam-user-cache:invalidate';

/**
 * Fake Redis pair: `publish` on the client re-emits a 'message' on the shared subscriber for every channel that was
 * SUBSCRIBEd, so a mapper also receives its own broadcast — as it does against a real Redis.
 */
function createRedisStub() {
  const events = new EventEmitter();
  const channels = new Set<string>();
  const publish = vi.fn(async (channel: string, message: string) => {
    if (channels.has(channel)) {
      events.emit('message', channel, message);
    }
    return 1;
  });
  const subscriber = {
    off: (event: string, listener: any) => events.off(event, listener),
    on: (event: string, listener: any) => events.on(event, listener),
  };
  const subscribeChannel = vi.fn(async (channel: string) => {
    channels.add(channel);
  });
  const releaseChannel = vi.fn(async (channel: string) => {
    channels.delete(channel);
  });
  const service = {
    enabled: true,
    getClient: () => ({ publish }),
    getSubscriber: () => subscriber,
    key: (...parts: string[]) => ['app', ...parts].join(':'),
    releaseChannel,
    subscribeChannel,
  } as unknown as CoreRedisService;
  return { events, publish, releaseChannel, service, subscribeChannel };
}

function seed(mapper: CoreBetterAuthUserMapper, iamId: string): void {
  (mapper as any).cacheUserData(iamId, { id: `db-${iamId}`, roles: ['admin'], verified: true });
}

function cached(mapper: CoreBetterAuthUserMapper, iamId: string): boolean {
  return (mapper as any).userCache.has(iamId);
}

describe('CoreBetterAuthUserMapper cache invalidation across replicas', () => {
  const mappers: CoreBetterAuthUserMapper[] = [];

  function createMapper(redisService?: CoreRedisService): CoreBetterAuthUserMapper {
    const mapper = new CoreBetterAuthUserMapper(undefined, redisService);
    mappers.push(mapper);
    return mapper;
  }

  afterEach(() => {
    mappers.splice(0).forEach((mapper) => mapper.onModuleDestroy());
    vi.restoreAllMocks();
  });

  /**
   * @regression   12.1.1 (DEV-3895) — invalidateUserCache() cleared only the replica it ran on, so an admin whose role was
   *   withdrawn kept it on every other replica for up to 15 s.
   * @seen-failing Drop the publishInvalidation() call from invalidateUserCache() in
   *   src/core/modules/better-auth/core-better-auth-user.mapper.ts — registered as mutation
   *   `iam-user-cache-invalidation-not-broadcast` in tests/regression-mutations.json.
   */
  it('clears the entry on another replica that shares the Redis', async () => {
    const redis = createRedisStub();
    const replicaA = createMapper(redis.service);
    const replicaB = createMapper(redis.service);
    await replicaA.onApplicationBootstrap();
    await replicaB.onApplicationBootstrap();
    seed(replicaA, 'iam-1');
    seed(replicaB, 'iam-1');
    seed(replicaB, 'iam-2');

    replicaA.invalidateUserCache('iam-1');
    await Promise.resolve();

    expect(redis.publish).toHaveBeenCalledWith(CHANNEL, JSON.stringify({ iamId: 'iam-1' }));
    expect(cached(replicaA, 'iam-1')).toBe(false);
    expect(cached(replicaB, 'iam-1')).toBe(false);
    expect(cached(replicaB, 'iam-2')).toBe(true);
  });

  it('subscribes through the Redis service, so the subscription comes back after a reconnect', async () => {
    const redis = createRedisStub();
    await createMapper(redis.service).onApplicationBootstrap();

    expect(redis.subscribeChannel).toHaveBeenCalledWith(CHANNEL);
  });

  /**
   * @regression   12.1.1 (DEV-3895) — a withdrawn role reached the user's open GraphQL WebSockets on the other replicas
   *   only at the next periodic re-check (subscriptionRevalidationMs, 30 s).
   * @seen-failing Drop the revalidateWsConnectionsOf() call from applyInvalidation() in
   *   src/core/modules/better-auth/core-better-auth-user.mapper.ts — registered as mutation
   *   `iam-user-cache-remote-ws-not-revalidated` in tests/regression-mutations.json.
   */
  it('re-checks the open WebSockets of that user after clearing the cache', async () => {
    const redis = createRedisStub();
    const replicaB = createMapper(redis.service);
    await replicaB.onApplicationBootstrap();
    seed(replicaB, 'iam-ws');

    const cacheSeenByReauthentication: boolean[] = [];
    const socket = new EventEmitter() as EventEmitter & { close: () => void };
    socket.close = vi.fn();
    const user = { id: 'db-iam-ws', iamId: 'iam-ws', roles: ['admin'] };
    registerWsConnection({
      carrier: {},
      reauthenticate: async () => {
        cacheSeenByReauthentication.push(cached(replicaB, 'iam-ws'));
        return user;
      },
      socket: socket as any,
      user,
    });

    // The broadcast as another replica sends it
    redis.events.emit('message', CHANNEL, JSON.stringify({ iamId: 'iam-ws' }));
    await vi.waitFor(() => expect(cacheSeenByReauthentication).toEqual([false]));
    socket.emit('close');
  });

  it('ignores messages of other channels and malformed ones', async () => {
    const redis = createRedisStub();
    const mapper = createMapper(redis.service);
    await mapper.onApplicationBootstrap();
    seed(mapper, 'iam-1');

    redis.events.emit('message', 'app:tenant-cache:invalidate', JSON.stringify({ iamId: 'iam-1' }));
    redis.events.emit('message', CHANNEL, 'not json');
    redis.events.emit('message', CHANNEL, JSON.stringify({ iamId: 42 }));

    expect(cached(mapper, 'iam-1')).toBe(true);
  });

  it('broadcasts even when the local cache is off, because the other replicas re-check their WebSockets', () => {
    const redis = createRedisStub();
    const mapper = createMapper(redis.service);
    (mapper as any).userCacheTtlMs = 0;

    mapper.invalidateUserCache('iam-1');

    expect(redis.publish).toHaveBeenCalledTimes(1);
  });

  it('warns when the broadcast cannot be sent, and still clears locally', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const redis = createRedisStub();
    redis.publish.mockRejectedValueOnce(new Error('Connection is closed'));
    const mapper = createMapper(redis.service);
    seed(mapper, 'iam-1');

    mapper.invalidateUserCache('iam-1');

    expect(cached(mapper, 'iam-1')).toBe(false);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('Connection is closed')));
  });

  it('detaches its listener and releases the channel on shutdown', async () => {
    const redis = createRedisStub();
    const mapper = createMapper(redis.service);
    await mapper.onApplicationBootstrap();
    seed(mapper, 'iam-1');

    mapper.onModuleDestroy();
    redis.events.emit('message', CHANNEL, JSON.stringify({ iamId: 'iam-1' }));

    expect(redis.releaseChannel).toHaveBeenCalledWith(CHANNEL);
    expect(redis.events.listenerCount('message')).toBe(0);
  });

  describe('without redis', () => {
    it('clears locally and has nothing to broadcast or subscribe', async () => {
      const mapper = createMapper(undefined);
      await mapper.onApplicationBootstrap();
      seed(mapper, 'iam-1');
      seed(mapper, 'iam-2');

      mapper.invalidateUserCache('iam-1');

      expect(cached(mapper, 'iam-1')).toBe(false);
      expect(cached(mapper, 'iam-2')).toBe(true);
    });

    it('treats a configured-but-disabled Redis service like no Redis', async () => {
      const redis = createRedisStub();
      (redis.service as any).enabled = false;
      const mapper = createMapper(redis.service);
      await mapper.onApplicationBootstrap();

      mapper.invalidateUserCache('iam-1');

      expect(redis.subscribeChannel).not.toHaveBeenCalled();
      expect(redis.publish).not.toHaveBeenCalled();
    });
  });
});
