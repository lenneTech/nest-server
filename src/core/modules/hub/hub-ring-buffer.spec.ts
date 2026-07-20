import { describe, expect, it } from 'vitest';

import { HubRingBuffer } from './hub-ring-buffer';

interface TestEntry {
  seq: number;
  timestamp: number;
  value: string;
}

describe('HubRingBuffer', () => {
  it('assigns monotonic sequence numbers and a timestamp', () => {
    const buffer = new HubRingBuffer<TestEntry>(3);
    const a = buffer.add({ value: 'a' });
    const b = buffer.add({ value: 'b' });

    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(typeof a.timestamp).toBe('number');
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it('honors an explicitly provided timestamp', () => {
    const buffer = new HubRingBuffer<TestEntry>(3);
    const entry = buffer.add({ timestamp: 123456, value: 'a' });

    expect(entry.timestamp).toBe(123456);
  });

  it('evicts the oldest entries once capacity is exceeded (fixed memory)', () => {
    const buffer = new HubRingBuffer<TestEntry>(3);
    for (const value of ['a', 'b', 'c', 'd', 'e']) {
      buffer.add({ value });
    }

    const items = buffer.recent();
    expect(items.map((i) => i.value)).toEqual(['c', 'd', 'e']);
    expect(buffer.size).toBe(3);
  });

  it('recent(limit) returns the newest N entries, oldest→newest', () => {
    const buffer = new HubRingBuffer<TestEntry>(5);
    for (const value of ['a', 'b', 'c', 'd']) {
      buffer.add({ value });
    }

    expect(buffer.recent(2).map((i) => i.value)).toEqual(['c', 'd']);
  });

  it('since(seq) returns only entries newer than the cursor', () => {
    const buffer = new HubRingBuffer<TestEntry>(10);
    buffer.add({ value: 'a' }); // seq 0
    const b = buffer.add({ value: 'b' }); // seq 1
    buffer.add({ value: 'c' }); // seq 2

    expect(buffer.since(b.seq).map((i) => i.value)).toEqual(['c']);
    expect(buffer.since(-1).map((i) => i.value)).toEqual(['a', 'b', 'c']);
    expect(buffer.since(buffer.lastSeq)).toEqual([]);
  });

  it('since(seq) clamps to what is still retained after eviction', () => {
    const buffer = new HubRingBuffer<TestEntry>(3);
    for (const value of ['a', 'b', 'c', 'd', 'e']) {
      buffer.add({ value }); // seqs 0..4, only 2,3,4 retained
    }

    // Asking since an evicted cursor (seq 0) returns only what survives, no crash, no duplicates.
    expect(buffer.since(0).map((i) => i.value)).toEqual(['c', 'd', 'e']);
    expect(buffer.firstRetainedSeq).toBe(2);
  });

  it('exposes lastSeq (-1 when empty) and firstRetainedSeq', () => {
    const buffer = new HubRingBuffer<TestEntry>(3);
    expect(buffer.lastSeq).toBe(-1);
    expect(buffer.firstRetainedSeq).toBe(-1);
    expect(buffer.size).toBe(0);

    buffer.add({ value: 'a' });
    expect(buffer.lastSeq).toBe(0);
    expect(buffer.firstRetainedSeq).toBe(0);
  });

  it('clear() empties the buffer but keeps the sequence counter monotonic', () => {
    const buffer = new HubRingBuffer<TestEntry>(3);
    buffer.add({ value: 'a' });
    buffer.add({ value: 'b' });
    buffer.clear();

    expect(buffer.size).toBe(0);
    expect(buffer.recent()).toEqual([]);
    // A new entry after clear must not reuse an old seq (cursors stay valid across a clear).
    const c = buffer.add({ value: 'c' });
    expect(c.seq).toBe(2);
  });
});
