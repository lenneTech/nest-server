import { describe, expect, it } from 'vitest';

import { normalizeCommandShape } from './hub-command-shape.helper';

describe('normalizeCommandShape', () => {
  it('replaces scalar values with a placeholder but keeps keys', () => {
    const out = normalizeCommandShape({ email: 'alice@example.com', age: 30, active: true });
    expect(out).toEqual({ active: '?', age: '?', email: '?' });
  });

  it('keeps Mongo operators as keys (they are structure, not data)', () => {
    const out = normalizeCommandShape({ age: { $gte: 18, $lt: 65 } });
    expect(out).toEqual({ age: { $gte: '?', $lt: '?' } });
  });

  it('collapses scalar arrays ($in) to a single placeholder', () => {
    const out = normalizeCommandShape({ id: { $in: [1, 2, 3, 4] } });
    expect(out).toEqual({ id: { $in: ['?'] } });
  });

  it('keeps per-stage shape for pipeline-like object arrays', () => {
    const out = normalizeCommandShape([{ $match: { x: 1 } }, { $group: { _id: '$y' } }]) as unknown[];
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ $match: { x: '?' } });
  });

  it('does NOT leak the original values (privacy)', () => {
    const secret = 'super-secret@example.com';
    const out = normalizeCommandShape({ filter: { email: secret } });
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it('caps recursion depth', () => {
    let deep: any = 'leaf';
    for (let i = 0; i < 20; i++) {
      deep = { nested: deep };
    }
    const out = JSON.stringify(normalizeCommandShape(deep));
    // Must terminate and not blow the stack; the sentinel marks the cut.
    expect(out).toContain('…');
  });

  it('produces identical output for identical query shapes (the N+1 template key)', () => {
    const a = normalizeCommandShape({ filter: { email: 'a@x.com' }, limit: 1 });
    const b = normalizeCommandShape({ filter: { email: 'b@y.com' }, limit: 999 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
