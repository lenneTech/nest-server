import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CoreRedisPubSub } from './core-redis-pubsub';

import type { CoreRedisService } from './core-redis.service';

/**
 * Fake Redis pair: `publish` on the client re-emits a 'message' event on the
 * subscriber, but only for channels that were actually SUBSCRIBEd.
 */
function createRedisStub() {
  const events = new EventEmitter();
  const channels = new Set<string>();

  const subscribe = vi.fn(async (channel: string) => {
    channels.add(channel);
  });
  const unsubscribe = vi.fn(async (channel: string) => {
    channels.delete(channel);
  });
  const publish = vi.fn(async (channel: string, message: string) => {
    if (channels.has(channel)) {
      events.emit('message', channel, message);
    }
  });

  const subscriber = { on: (event: string, listener: any) => events.on(event, listener), subscribe, unsubscribe };
  const service = {
    enabled: true,
    getClient: () => ({ publish }),
    getSubscriber: () => subscriber,
    key: (...parts: string[]) => ['nest-server', ...parts].join(':'),
  } as unknown as CoreRedisService;

  return { events, publish, service, subscribe, unsubscribe };
}

describe('CoreRedisPubSub', () => {
  let stub: ReturnType<typeof createRedisStub>;
  let pubSub: CoreRedisPubSub;

  beforeEach(() => {
    stub = createRedisStub();
    pubSub = new CoreRedisPubSub(stub.service);
  });

  it('delivers a deserialized payload to the subscriber', async () => {
    const received: any[] = [];
    await pubSub.subscribe('userCreated', (payload) => received.push(payload));

    await pubSub.publish('userCreated', { id: '1', name: 'Test' });

    expect(stub.publish).toHaveBeenCalledWith('nest-server:pubsub:userCreated', '{"id":"1","name":"Test"}');
    expect(received).toEqual([{ id: '1', name: 'Test' }]);
  });

  it('delivers to multiple subscribers of the same trigger', async () => {
    const first: any[] = [];
    const second: any[] = [];
    await pubSub.subscribe('userCreated', (payload) => first.push(payload));
    await pubSub.subscribe('userCreated', (payload) => second.push(payload));

    await pubSub.publish('userCreated', 42);

    expect(first).toEqual([42]);
    expect(second).toEqual([42]);
  });

  it('issues a Redis SUBSCRIBE only once per channel', async () => {
    await pubSub.subscribe('userCreated', () => {});
    await pubSub.subscribe('userCreated', () => {});
    await pubSub.subscribe('userDeleted', () => {});

    expect(stub.subscribe).toHaveBeenCalledTimes(2);
    expect(stub.subscribe).toHaveBeenCalledWith('nest-server:pubsub:userCreated');
    expect(stub.subscribe).toHaveBeenCalledWith('nest-server:pubsub:userDeleted');
  });

  it('stops delivery after unsubscribe and releases the channel on the last handler', async () => {
    const first: any[] = [];
    const second: any[] = [];
    const firstId = await pubSub.subscribe('userCreated', (payload) => first.push(payload));
    const secondId = await pubSub.subscribe('userCreated', (payload) => second.push(payload));

    await pubSub.unsubscribe(firstId);
    await pubSub.publish('userCreated', 'a');

    expect(first).toEqual([]);
    expect(second).toEqual(['a']);
    expect(stub.unsubscribe).not.toHaveBeenCalled();

    await pubSub.unsubscribe(secondId);
    await pubSub.publish('userCreated', 'b');

    expect(stub.unsubscribe).toHaveBeenCalledWith('nest-server:pubsub:userCreated');
    expect(second).toEqual(['a']);
  });

  it('ignores messages of channels it does not handle', async () => {
    const received: any[] = [];
    await pubSub.subscribe('userCreated', (payload) => received.push(payload));

    stub.events.emit('message', 'nest-server:tenant-cache:invalidate', '{"scope":"all"}');

    expect(received).toEqual([]);
  });

  it('provides an async iterable iterator over the trigger', async () => {
    const iterator = pubSub.asyncIterableIterator<number>('userCreated');
    const next = iterator.next();
    // Give the iterator's internal subscribe() a chance to complete
    await new Promise((resolve) => setImmediate(resolve));

    await pubSub.publish('userCreated', 7);

    expect((await next).value).toBe(7);
    await iterator.return?.();
  });
});
