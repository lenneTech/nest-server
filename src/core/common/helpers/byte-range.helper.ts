/**
 * A byte range of a file: the bytes `start` through `end`, both INCLUSIVE — the way HTTP counts them
 * (`Range: bytes=0-1` is two bytes) and `fs.createReadStream()` takes them.
 *
 * Read with `CoreFileService.getFileStream(id, { range })` / `getFileStreamByName()` or
 * `CoreS3Service.getObject(key, { range })`. The range must lie inside the file (`end` below its
 * length); {@link parseRangeHeader} / `resolveDownloadRange()` produce such a range from a request.
 */
export interface ByteRange {
  /** Last byte, inclusive */
  end: number;
  /** First byte, counted from 0 */
  start: number;
}

/**
 * What {@link parseRangeHeader} decided about a `Range` header:
 * - a {@link ByteRange} — deliver these bytes (`206 Partial Content`);
 * - `'unsatisfiable'` — the range starts at or past the end of the file (`416 Range Not Satisfiable`);
 * - `undefined` — deliver the whole file (`200`), the header asks for nothing this server serves.
 */
export type RangeHeaderDecision = 'unsatisfiable' | ByteRange | undefined;

/**
 * Longest `Range` header that is parsed at all. A single byte range of a file the size of any store's limit is
 * well below 100 characters; a longer header is a list of ranges or garbage, and both are answered with the whole
 * file anyway.
 */
const MAX_RANGE_HEADER_LENGTH = 200;

/** One range of the set, `first-last`, `first-` or `-suffix`. Anchored and without nested quantifiers. */
const RANGE_SPEC = /^(\d*)[ \t]*-[ \t]*(\d*)$/;

/** The unit and the range set: `bytes=<set>`, the unit case-insensitive (RFC 9110 §14.1) */
const RANGE_UNIT = /^[ \t]*bytes[ \t]*=(.*)$/i;

/**
 * Decide what a `Range` request header asks for, against a file of `length` bytes (RFC 9110 §14.1.2, §14.2).
 *
 * Only ONE range is served. The whole file (`undefined`) is the answer to:
 * - no header, an empty one, or a unit other than `bytes`;
 * - an invalid header (`bytes=5-2`, `bytes=abc`, `bytes=-`) — RFC 9110 lets a server ignore it, and the whole file
 *   is what a client that sent garbage can still use;
 * - SEVERAL ranges (`bytes=0-1,5-9`): a `multipart/byteranges` answer is not served, the way Express's `send` does
 *   it. Media players and download managers ask for one range at a time;
 * - a file whose length is unknown (`undefined`, negative, not an integer): a `206` must name the total length.
 *
 * `'unsatisfiable'` is the answer to a single range that starts at or past the end of the file, or a suffix range
 * of length 0 — and to every range of an EMPTY file, which has no byte to start at.
 *
 * A range that ends past the file is cut at its last byte, and a suffix longer than the file is the whole file —
 * both are satisfiable by definition, so a client may ask for `bytes=0-` or `bytes=0-999999999` without knowing
 * the size.
 *
 * Pure function, no I/O — the HTTP glue (`resolveDownloadRange()`, `setDownloadRangeHeaders()`) lives next to
 * `pipeFileToResponse()` in the file module.
 */
export function parseRangeHeader(
  header: string | string[] | undefined,
  length: number | undefined,
): RangeHeaderDecision {
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    return undefined;
  }
  // Node joins repeated headers with ', ' — a repeated Range header is a list of ranges, answered with the whole file
  const value = Array.isArray(header) ? header.join(',') : header;
  if (typeof value !== 'string' || !value || value.length > MAX_RANGE_HEADER_LENGTH) {
    return undefined;
  }
  const unit = RANGE_UNIT.exec(value);
  if (!unit) {
    return undefined;
  }
  // Empty list elements are allowed and ignored (RFC 9110 §5.6.1)
  const specs = unit[1]
    .split(',')
    .map((spec) => spec.trim())
    .filter(Boolean);
  if (specs.length !== 1) {
    return undefined;
  }
  const match = RANGE_SPEC.exec(specs[0]);
  if (!match) {
    return undefined;
  }
  const [, first, last] = match;
  if (!first && !last) {
    return undefined;
  }
  if (!first) {
    // Suffix range: the last N bytes
    const suffix = toSafeInteger(last);
    if (suffix === undefined) {
      return undefined;
    }
    if (suffix === 0 || length === 0) {
      return 'unsatisfiable';
    }
    return { end: length - 1, start: Math.max(0, length - suffix) };
  }
  const start = toSafeInteger(first);
  const end = last ? toSafeInteger(last) : length - 1;
  if (start === undefined || end === undefined) {
    return undefined;
  }
  if (last && end < start) {
    // `bytes=5-2` is invalid, not unsatisfiable — ignored
    return undefined;
  }
  if (start >= length) {
    return 'unsatisfiable';
  }
  return { end: Math.min(end, length - 1), start };
}

/**
 * Check a range handed to a store read: two safe integers, `0 <= start <= end`. Returns it unchanged, `undefined`
 * for no range, and throws a `RangeError` for anything else — the same answer from every store, before any of them
 * is asked (each would otherwise fail in its own way: S3 with `InvalidRange`, GridFS with a driver error on the
 * stream, the filesystem with a silently empty stream).
 */
export function assertByteRange(range: unknown): ByteRange | undefined {
  if (range === undefined || range === null) {
    return undefined;
  }
  const { end, start } = range as { end: number; start: number };
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new RangeError(
      `Invalid byte range { start: ${String(start)}, end: ${String(end)} }: start and end must be integers with 0 <= start <= end (end inclusive)`,
    );
  }
  return { end, start };
}

/** The `Content-Range` value of a range of a file with `length` bytes: `bytes 0-1/1234` */
export function contentRangeValue(range: ByteRange, length: number): string {
  return `bytes ${range.start}-${range.end}/${length}`;
}

/** Digits as a safe integer, `undefined` when they exceed what a Number holds exactly */
function toSafeInteger(digits: string): number | undefined {
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : undefined;
}
