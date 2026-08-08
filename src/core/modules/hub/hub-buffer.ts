import { Logger } from '@nestjs/common';

import { CoreRedisService } from '../../common/services/core-redis.service';
import { HubBufferEntry, HubRingBuffer } from './hub-ring-buffer';

/** A buffer read, shaped like the `cursor` / `dropped` fields every Hub panel payload carries. */
export interface HubBufferData<T> {
  /** Highest assigned seq (`-1` when nothing was ever added) — the client's next cursor. */
  cursor: number;
  /** Seq of the oldest retained entry (`-1` when empty) — clients detect eviction gaps against this. */
  dropped: number;
  entries: T[];
}

/**
 * A collector buffer with an OPTIONAL Redis backing — the single boundary at which the Hub's
 * diagnostic collectors (logs, traces, queries, mailbox) become multi-replica aware.
 *
 * Without Redis this is exactly the process-local {@link HubRingBuffer} and nothing changes.
 * With Redis (`ServerOptions.redis`) every append is ALSO mirrored into a capped Redis list
 * (`LPUSH` + `LTRIM` to the same capacity) and reads come from that list, so every pod shows
 * the merged view instead of only its own slice.
 *
 * **Sequence numbers stay meaningful across replicas.** The mirror keeps a companion counter:
 * the write is `MULTI: INCR seq / LPUSH / LTRIM` and the read is `MULTI: GET seq / LRANGE`,
 * both atomic, so the newest list element is always `seq = total - 1` and the counter can
 * never disagree with the list. `clear()` deletes only the list — the counter keeps advancing,
 * so existing client cursors stay valid, matching `HubRingBuffer.clear()`.
 *
 * **Writes are fire-and-forget.** The collectors sit in hot paths (every log line, every
 * request) and their API towards callers must stay synchronous. A Redis failure is logged at
 * debug level; reads then fall back to the local buffer rather than failing the panel.
 */
export class HubBuffer<T extends HubBufferEntry> {
  protected readonly listKey: string;
  protected readonly local: HubRingBuffer<T>;
  protected readonly logger = new Logger(HubBuffer.name);
  protected readonly redis?: CoreRedisService;
  protected readonly seqKey: string;

  constructor(capacity: number, name: string, redis?: CoreRedisService) {
    this.local = new HubRingBuffer<T>(capacity);
    this.redis = redis?.enabled ? redis : undefined;
    this.listKey = this.redis?.key('hub', name) ?? '';
    this.seqKey = this.redis?.key('hub', name, 'seq') ?? '';
  }

  /** Append an entry. Returns the local entry (with its process-local seq) synchronously. */
  add(entry: Omit<T, 'seq' | 'timestamp'> & { timestamp?: number }): T {
    const full = this.local.add(entry);
    this.mirror('append', (client) =>
      client
        .multi()
        .incr(this.seqKey)
        .lpush(this.listKey, JSON.stringify(full))
        .ltrim(this.listKey, 0, this.local.capacity - 1)
        .exec(),
    );
    return full;
  }

  /** Drop all retained entries — on every replica when Redis-backed. */
  clear(): void {
    this.local.clear();
    this.mirror('clear', (client) => client.del(this.listKey));
  }

  /**
   * Run a fire-and-forget mirror write. Swallows BOTH failure modes: `getClient()` throws
   * synchronously before `CoreRedisService.onModuleInit` has run (log lines during bootstrap
   * reach the collector earlier than that), and the command itself rejects on an outage.
   * Neither may escape into a hot logging or request path.
   */
  protected mirror(label: string, run: (client: ReturnType<CoreRedisService['getClient']>) => Promise<unknown>): void {
    if (!this.redis) {
      return;
    }
    const failed = (err: Error): void =>
      this.logger.debug(`Hub buffer ${label} failed (${this.listKey}): ${err.message}`);
    try {
      run(this.redis.getClient()).catch(failed);
    } catch (err) {
      failed(err as Error);
    }
  }

  /** Entries oldest→newest, optionally only those newer than `since`. */
  async read(since?: number, limit?: number): Promise<HubBufferData<T>> {
    const shared = this.redis ? await this.readShared(since, limit) : undefined;
    if (shared) {
      return shared;
    }
    return {
      cursor: this.local.lastSeq,
      dropped: this.local.firstRetainedSeq,
      entries: since === undefined ? this.local.recent(limit) : this.local.since(since, limit),
    };
  }

  /** Read the shared list, or undefined when Redis is unreachable (caller falls back to local). */
  protected async readShared(since?: number, limit?: number): Promise<HubBufferData<T> | undefined> {
    try {
      const result = await this.redis!.getClient().multi().get(this.seqKey).lrange(this.listKey, 0, -1).exec();
      const total = Number(result?.[0]?.[1] ?? 0);
      const raw = (result?.[1]?.[1] ?? []) as string[];
      // LRANGE yields newest→oldest; the head carries `total - 1`. Walk backwards to get
      // oldest→newest and stamp the shared seq over the (per-replica) one that was serialized.
      const all: T[] = [];
      for (let i = raw.length - 1; i >= 0; i--) {
        try {
          all.push({ ...JSON.parse(raw[i]), seq: total - 1 - i } as T);
        } catch {
          // A single unparseable element must not blank the whole panel.
        }
      }
      const entries = since === undefined ? all : all.filter((entry) => entry.seq > since);
      return {
        cursor: total - 1,
        dropped: all.length ? all[0].seq : -1,
        entries: limit === undefined ? entries : entries.slice(-limit),
      };
    } catch (err) {
      this.logger.debug(`Hub buffer read failed (${this.listKey}), using the local buffer: ${(err as Error).message}`);
      return undefined;
    }
  }
}
