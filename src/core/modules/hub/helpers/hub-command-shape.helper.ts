/**
 * Normalize a MongoDB command fragment into a value-free SHAPE.
 *
 * Every scalar becomes `'?'` while keys and `$operators` are preserved. This serves two purposes at
 * once for the query profiler:
 *  1. Privacy — no filter values, no document contents, ever enter the ring buffer.
 *  2. N+1 detection — identical query shapes normalize to identical strings, so they can be grouped
 *     and counted (the "top templates" view).
 *
 * Bounds keep a pathological command from exhausting memory/stack: depth 5, 32 keys per object,
 * object-arrays truncated to 8 elements.
 */

const MAX_DEPTH = 5;
const MAX_KEYS = 32;
const MAX_ARRAY_ITEMS = 8;
const DEPTH_SENTINEL = '…';
const PLACEHOLDER = '?';

export function normalizeCommandShape(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) {
    return DEPTH_SENTINEL;
  }

  if (Array.isArray(value)) {
    // Object arrays (pipelines, bulk ops) keep per-element shape; scalar arrays ($in) collapse.
    if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
      return value.slice(0, MAX_ARRAY_ITEMS).map((item) => normalizeCommandShape(item, depth + 1));
    }
    return [PLACEHOLDER];
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (++count > MAX_KEYS) {
        out[DEPTH_SENTINEL] = DEPTH_SENTINEL;
        break;
      }
      out[key] = normalizeCommandShape((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }

  return PLACEHOLDER;
}
