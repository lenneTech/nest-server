import { Logger } from '@nestjs/common';
import { PubSubEngine } from 'graphql-subscriptions';

import type { CoreRedisService } from './core-redis.service';
import type { Redis } from 'ioredis';

/**
 * Redis-backed drop-in replacement for the in-memory `PubSub` of `graphql-subscriptions`.
 *
 * Used as the `PUB_SUB` provider whenever Redis is enabled, so GraphQL subscriptions
 * are delivered across ALL replicas instead of only the process that published them.
 * `asyncIterableIterator()` is inherited from `PubSubEngine` and works unchanged.
 *
 * Payloads are JSON-serialized — they MUST be JSON-serializable. Class instances,
 * `Date` objects, `Map`/`Set` and `undefined` values do not survive the round trip.
 *
 * The subscriber connection is shared process-wide (`CoreRedisService.getSubscriber()`),
 * so this engine keeps its own channel → handler map and only issues a Redis
 * SUBSCRIBE/UNSUBSCRIBE when the first handler for a channel arrives / the last one leaves.
 */
export class CoreRedisPubSub extends PubSubEngine {
  protected readonly logger = new Logger(CoreRedisPubSub.name);

  /** Channel → (subscription id → handler) */
  protected readonly handlers = new Map<string, Map<number, (...args: any[]) => void>>();

  /** Whether the 'message' listener has been attached to the shared subscriber */
  protected messageListenerAttached = false;

  /** Subscription id → channel */
  protected readonly subscriptions = new Map<number, string>();

  protected subIdCounter = 0;

  constructor(protected readonly redisService: CoreRedisService) {
    super();
  }

  async publish(triggerName: string, payload: any): Promise<void> {
    await this.redisService.getClient().publish(this.channel(triggerName), JSON.stringify(payload));
  }

  async subscribe(triggerName: string, onMessage: (...args: any[]) => void): Promise<number> {
    const channel = this.channel(triggerName);
    let channelHandlers = this.handlers.get(channel);

    // First handler for this channel: subscribe on Redis
    if (!channelHandlers) {
      channelHandlers = new Map();
      this.handlers.set(channel, channelHandlers);
      try {
        await this.getSubscriber().subscribe(channel);
      } catch (error) {
        this.handlers.delete(channel);
        throw error;
      }
    }

    const subId = ++this.subIdCounter;
    channelHandlers.set(subId, onMessage);
    this.subscriptions.set(subId, channel);
    return subId;
  }

  async unsubscribe(subId: number): Promise<void> {
    const channel = this.subscriptions.get(subId);
    if (!channel) {
      return;
    }
    this.subscriptions.delete(subId);

    const channelHandlers = this.handlers.get(channel);
    if (!channelHandlers) {
      return;
    }
    channelHandlers.delete(subId);

    // Last handler for this channel: unsubscribe on Redis
    if (channelHandlers.size === 0) {
      this.handlers.delete(channel);
      await this.getSubscriber().unsubscribe(channel);
    }
  }

  /**
   * Framework-namespaced Redis channel for a GraphQL trigger name
   */
  protected channel(triggerName: string): string {
    return this.redisService.key('pubsub', triggerName);
  }

  /**
   * Deliver an incoming Redis message to all handlers of that channel.
   * Messages of channels this engine does not know (the subscriber connection is
   * shared with other framework features) are ignored.
   */
  protected dispatch(channel: string, message: string): void {
    const channelHandlers = this.handlers.get(channel);
    if (!channelHandlers?.size) {
      return;
    }
    let payload: any;
    try {
      payload = JSON.parse(message);
    } catch {
      this.logger.warn(`Ignoring non-JSON message on channel ${channel}`);
      return;
    }
    for (const handler of channelHandlers.values()) {
      handler(payload);
    }
  }

  /**
   * Shared subscriber connection with the 'message' listener attached once
   */
  protected getSubscriber(): Redis {
    const subscriber = this.redisService.getSubscriber();
    if (!this.messageListenerAttached) {
      this.messageListenerAttached = true;
      subscriber.on('message', (channel: string, message: string) => this.dispatch(channel, message));
    }
    return subscriber;
  }
}
