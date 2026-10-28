/**
 * Argument checks every data store applies the same way, so a call refused on one database is refused on all.
 */

/** native() / raw(): the reason is logged, so it has to say something */
export function assertAccessReason(reason: string, method: string): void {
  if (!reason?.trim() || reason.trim().length < 20) {
    throw new Error(`${method}() requires a meaningful reason (min 20 chars) — explain why native access is needed`);
  }
}

/** find({ sample }): a positive integer — MongoDB refuses anything else in `$sample`, so every store does */
export function assertSampleSize(sample: unknown): number {
  if (typeof sample !== 'number' || !Number.isInteger(sample) || sample < 1) {
    throw new Error(`sample must be a positive integer, got ${String(sample)}`);
  }
  return sample;
}

/** pushToArray() / pullFromArray(): a field name, never an operator */
export function assertArrayField(field: string, method: string): void {
  if (typeof field !== 'string' || !field || field.startsWith('$') || field.includes('\0')) {
    throw new Error(`${method}: invalid field name "${field}"`);
  }
}

const SELECTABLE = /^[A-Za-z_]\w*$/;

/**
 * `select`: plain field names only. MongoDB joins them into a projection string, where `+name` forces a
 * `select: false` field (a password hash) into the result and `-name` turns the projection into an exclusion —
 * a caller passing names through must not be able to do either by accident.
 */
export function assertSelectFields(select: readonly string[] | undefined): void {
  for (const field of select ?? []) {
    if (typeof field !== 'string' || !SELECTABLE.test(field)) {
      throw new Error(`select: invalid field name "${String(field)}"`);
    }
  }
}

/**
 * `select` and `exclude` together: plain field names each, and never both — MongoDB refuses a projection that
 * includes and excludes at once. The id cannot be left out: every record carries it.
 */
export function assertProjection(options: { exclude?: readonly string[]; select?: readonly string[] }): void {
  assertSelectFields(options.select);
  assertSelectFields(options.exclude);
  if (options.select?.length && options.exclude?.length) {
    throw new Error('select and exclude cannot be combined');
  }
  if (options.exclude?.some((field) => field === 'id' || field === '_id')) {
    throw new Error('exclude: the id is always returned');
  }
}
