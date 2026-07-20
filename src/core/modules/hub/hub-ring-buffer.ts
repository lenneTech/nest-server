/**
 * The minimum shape every Hub ring-buffer entry carries.
 *
 * `seq` is a monotonic, per-buffer sequence number (never reused, survives eviction and `clear()`),
 * so polling clients can pass the last seq they saw as a cursor and receive only newer entries.
 */
export interface HubBufferEntry {
  /** Monotonic per-buffer sequence number (0-based, never reused). */
  seq: number;
  /** Epoch milliseconds. */
  timestamp: number;
}

/**
 * Fixed-size ring buffer with O(1) append and cursor-based reads.
 *
 * - Append writes into `slots[seq % capacity]` — no `Array.shift()` (which would be O(n) and, on the
 *   long-lived buffers the Hub keeps, a steady GC drag). Memory is strictly `capacity × recordSize`.
 * - No timers, no statics: one instance per collector per Nest app instance, so parallel e2e apps in
 *   one process never share buffer state.
 *
 * See CLAUDE.md "High-Frequency Path Design Rules" (buffers need a size cap + eviction).
 */
export class HubRingBuffer<T extends HubBufferEntry> {
  /** Fixed capacity (entries retained). */
  public readonly capacity: number;

  /** Watermark raised by `clear()`: no seq below this is considered retained. */
  private minValidSeq = 0;
  private nextSeq = 0;
  private readonly slots: (T | undefined)[];

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.slots = Array.from<T | undefined>({ length: this.capacity });
  }

  /** Seq of the oldest retained entry (`-1` when empty) — clients detect eviction gaps against this. */
  get firstRetainedSeq(): number {
    return this.size === 0 ? -1 : this.oldestSeq;
  }

  /** Highest assigned seq (`-1` when nothing was ever added) — the client's next cursor. */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /** Number of entries currently retained. */
  get size(): number {
    return this.nextSeq - this.oldestSeq;
  }

  /** Earliest seq that could still be retained (bounded by capacity and by the last `clear()`). */
  private get oldestSeq(): number {
    return Math.max(this.nextSeq - this.capacity, this.minValidSeq);
  }

  /**
   * Append an entry. Assigns `seq` + `timestamp` (unless a timestamp is supplied) and overwrites the
   * oldest slot once full. Returns the fully-formed entry.
   */
  add(entry: Omit<T, 'seq' | 'timestamp'> & { timestamp?: number }): T {
    const full = {
      ...entry,
      seq: this.nextSeq,
      timestamp: entry.timestamp ?? Date.now(),
    } as T;
    this.slots[this.nextSeq % this.capacity] = full;
    this.nextSeq++;
    return full;
  }

  /** Drop all retained entries. The seq counter keeps advancing so existing cursors stay valid. */
  clear(): void {
    this.slots.fill(undefined);
    this.minValidSeq = this.nextSeq;
  }

  /** Newest up to `limit` entries, oldest→newest. */
  recent(limit: number = this.capacity): T[] {
    return this.collect(this.nextSeq - Math.max(0, limit));
  }

  /** Entries with `seq > sinceSeq`, clamped to what is still retained, oldest→newest. */
  since(sinceSeq: number, limit: number = this.capacity): T[] {
    const start = Math.max(sinceSeq + 1, this.nextSeq - Math.max(0, limit));
    return this.collect(start);
  }

  private collect(startSeq: number): T[] {
    const from = Math.max(startSeq, this.oldestSeq, 0);
    const result: T[] = [];
    for (let seq = from; seq < this.nextSeq; seq++) {
      const entry = this.slots[seq % this.capacity];
      if (entry !== undefined && entry.seq === seq) {
        result.push(entry);
      }
    }
    return result;
  }
}
