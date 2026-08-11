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
 * How long a mirrored buffer survives without being written to, in seconds.
 *
 * The list is size-bounded by LTRIM but was never time-bounded, so its contents outlived the
 * process, the deployment and every Redis snapshot taken in between. That matters because of WHAT
 * these buffers hold: log lines, full request traces and — in mailbox capture mode — whole
 * outgoing emails, including verification and password-reset links that are still valid.
 * Diagnostics are worth keeping for a shift, not forever.
 */
const DEFAULT_SHARED_TTL_SECONDS = 24 * 60 * 60;

/**
 * Entries fetched per poll before the range is widened.
 *
 * A Hub panel polls every 5s and normally sees single-digit deltas, while the trace buffer holds
 * up to 1000 entries — reading and parsing the whole list on every poll of every open tab was
 * paying 1000× for that delta. The widen-and-retry loop below keeps the read exact when a client
 * really is further behind.
 */
const SHARED_READ_CHUNK = 64;

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
  protected readonly redis?: CoreRedisService;
  protected readonly seqKey: string;

  /** Retention of the mirrored list, refreshed on every append. */
  protected readonly ttlSeconds: number;

  constructor(capacity: number, name: string, redis?: CoreRedisService, ttlSeconds = DEFAULT_SHARED_TTL_SECONDS) {
    this.local = new HubRingBuffer<T>(capacity);
    this.redis = redis?.enabled ? redis : undefined;
    this.listKey = this.redis?.key('hub', name) ?? '';
    this.seqKey = this.redis?.key('hub', name, 'seq') ?? '';
    this.ttlSeconds = ttlSeconds;
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
        // Refreshed on every append, so an actively used buffer never expires and an abandoned one
        // (a scaled-down replica, a torn-down environment) stops being a durable copy of captured
        // logs, traces and emails. Only the LIST expires — the seq counter must survive so client
        // cursors stay valid, exactly as they do across clear().
        .expire(this.listKey, this.ttlSeconds)
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
      // console, NOT Logger: the Hub logs collector captures Logger output INTO a HubBuffer,
      // so reporting a mirror failure through Logger re-enters this very method. With a
      // synchronous throw from getClient() — exactly what happens for log lines emitted
      // before CoreRedisService has connected — that recurses on one stack until it
      // overflows, turning a Redis hiccup into a crashed process.
      console.debug(`Hub buffer ${label} failed (${this.listKey}): ${err.message}`);
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

  /**
   * Read the shared list, or undefined when Redis is unreachable (caller falls back to local).
   *
   * The list is newest-first, so the entry with seq `s` sits at index `total - 1 - s` and the
   * entries a client with cursor `since` still needs are exactly the first `total - 1 - since`.
   * `total` is only known once the read has happened, so the range starts at a poll-sized chunk
   * and is widened only when that turns out not to have covered the client's cursor — which keeps
   * the common poll O(delta) instead of O(capacity) without ever returning a short answer.
   */
  protected async readShared(since?: number, limit?: number): Promise<HubBufferData<T> | undefined> {
    try {
      const client = this.redis!.getClient();
      const capacity = this.local.capacity;
      const cap = Math.min(limit ?? capacity, capacity);
      // Without a cursor the caller wants the newest window, which LTRIM already bounds by
      // capacity — so the full range is exact rather than a guess.
      let want = Math.max(1, since === undefined ? cap : Math.min(cap, SHARED_READ_CHUNK));

      for (let attempt = 0; ; attempt++) {
        const result = await client
          .multi()
          .get(this.seqKey)
          .lrange(this.listKey, 0, want - 1)
          .exec();
        const total = Number(result?.[0]?.[1] ?? 0);
        const raw = (result?.[1]?.[1] ?? []) as string[];
        const needed = since === undefined ? cap : Math.max(0, Math.min(cap, total - 1 - since));

        // Enough in hand, or the list simply ended before the bound, or we have widened often
        // enough — three more round trips is already pathological, and answering with what we
        // have beats spinning while the panel waits.
        if (raw.length >= needed || raw.length < want || attempt >= 2) {
          return this.shape(total, raw, needed);
        }
        want = Math.min(Math.max(needed, want * 4), capacity);
      }
    } catch (err) {
      // console, NOT Logger — same re-entrancy as in mirror() above
      console.debug(`Hub buffer read failed (${this.listKey}), using the local buffer: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Turn a newest-first slice into the oldest→newest payload, stamping the SHARED seq over the
   * per-replica one that was serialized.
   *
   * `dropped` is derived from what the slice covers, so for a polling client it reports "nothing
   * you had was evicted" — and when entries really were evicted (the client is further behind than
   * the buffer is deep) the slice ends early and the true gap surfaces.
   */
  protected shape(total: number, raw: string[], needed: number): HubBufferData<T> {
    const entries: T[] = [];
    for (let i = Math.min(raw.length, needed) - 1; i >= 0; i--) {
      try {
        entries.push({ ...JSON.parse(raw[i]), seq: total - 1 - i } as T);
      } catch {
        // A single unparseable element must not blank the whole panel.
      }
    }
    return {
      cursor: total - 1,
      dropped: raw.length ? total - raw.length : -1,
      entries,
    };
  }
}
