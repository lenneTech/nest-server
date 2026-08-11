import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { CoreRedisService } from '../../common/services/core-redis.service';

/** Release callback handed to the current lock holder when someone else wants the resource */
type RequestRelease = () => Promise<void> | void;

/**
 * TUS lock that is exclusive across REPLICAS, not just within one process.
 *
 * `@tus/server` defaults to an in-memory locker, which is exactly right for one process and
 * useless behind a load balancer: two replicas each hold their own lock for the same upload id
 * and both accept a PATCH, so two byte ranges are written to one upload and the file ends up
 * interleaved. Resumable uploads are long-lived and clients retry aggressively, so a request
 * pair landing on different replicas is the normal case, not a rare one.
 *
 * The lock is a Redis key with a TTL held only while a request is being served, refreshed by a
 * heartbeat so a slow but live PATCH keeps it, and released in `unlock()`. A holder that dies
 * mid-request stops refreshing and the key expires — the upload becomes writable again instead
 * of being stuck until someone intervenes.
 */
export class TusRedisLock {
  protected heartbeat?: NodeJS.Timeout;

  /** Random per-acquisition value, so only the actual holder can release or refresh the lock */
  protected token?: string;

  constructor(
    protected readonly redisService: CoreRedisService,
    protected readonly key: string,
    protected readonly ttlMs: number,
    protected readonly acquireTimeoutMs: number,
  ) {}

  /**
   * Wait for exclusive access to the upload, or throw once the timeout is reached.
   *
   * `cancelReq` is the TUS mechanism for cooperative handover: when a newer request wants an
   * upload we already hold, the holder is asked to let go rather than made to wait it out.
   */
  async lock(signal: AbortSignal, cancelReq: RequestRelease): Promise<void> {
    const deadline = Date.now() + this.acquireTimeoutMs;
    // randomUUID, not Math.random: this token is the ONLY thing separating "holds the lock" from
    // "does not" in the compare-and-delete below and in the heartbeat's PEXPIRE. A collision lets
    // one holder refresh or release another's lock, and two replicas then interleave byte ranges
    // into one upload — the exact corruption this locker exists to prevent.
    const token = `${process.pid}-${randomUUID()}`;

    for (;;) {
      const acquired = await this.redisService.getClient().set(this.key, token, 'PX', this.ttlMs, 'NX');

      if (acquired === 'OK') {
        this.token = token;
        this.startHeartbeat();
        return;
      }

      // Tell whoever holds it that someone else is waiting. Signalling on every attempt is
      // deliberate: the holder may be on another replica and only learns of us through this.
      await cancelReq();

      if (signal.aborted || Date.now() > deadline) {
        throw new Error(`Could not acquire the upload lock for "${this.key}" within ${this.acquireTimeoutMs}ms`);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Release the lock — only if we still hold it */
  async unlock(): Promise<void> {
    this.stopHeartbeat();
    const token = this.token;
    this.token = undefined;
    if (!token) {
      return;
    }

    // Compare-and-delete: after our TTL expired the key may already belong to someone else,
    // and deleting it blindly would unlock an upload another replica is actively writing.
    const script = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
    try {
      await this.redisService.getClient().eval(script, 1, this.key, token);
    } catch {
      // The key expires on its own; a failed release costs at most one TTL of waiting.
    }
  }

  /** Keep the lock alive while the request is still being served */
  protected startHeartbeat(): void {
    this.heartbeat = setInterval(
      () => {
        const token = this.token;
        if (!token) {
          return;
        }
        const script = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`;
        this.redisService
          .getClient()
          .eval(script, 1, this.key, token, this.ttlMs)
          .catch(() => undefined);
      },
      Math.max(1000, Math.floor(this.ttlMs / 3)),
    );
    this.heartbeat.unref?.();
  }

  protected stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
}

/**
 * Locker handed to `@tus/server` when Redis is configured (see {@link TusRedisLock}).
 */
export class TusRedisLocker {
  protected readonly logger = new Logger(TusRedisLocker.name);

  constructor(
    protected readonly redisService: CoreRedisService,
    /** How long a lock survives without a heartbeat — a dead holder's upload frees itself */
    protected readonly ttlMs = 30_000,
    /** How long a request waits for a busy upload before giving up with 500 */
    protected readonly acquireTimeoutMs = 10_000,
  ) {}

  newLock(id: string): TusRedisLock {
    return new TusRedisLock(
      this.redisService,
      this.redisService.key('tus-lock', id),
      this.ttlMs,
      this.acquireTimeoutMs,
    );
  }
}
