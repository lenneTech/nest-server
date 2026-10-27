import { isObjectIdLike } from '../helpers/id.helper.js';

export { isObjectIdLike } from '../helpers/id.helper.js';

/**
 * The stored id format, the same on every database: 24 hex characters — an ObjectId's hex string.
 * On MongoDB that IS the ObjectId; on SQL the application generates it (plan §3.5), so ids, URLs and
 * validators stay identical across the fleet and survive a data move between databases.
 */
const STORED_ID = /^[0-9a-f]{24}$/i;

/**
 * Whether a value is a well-formed stored id: an ObjectId (from any bson copy) or its 24-character hex
 * string.
 *
 * Deliberately stricter than `Types.ObjectId.isValid()`, which also accepts any 12-character string
 * (a 12-byte ObjectId seed) — no stored id ever has that form. For strings this is exactly the rule
 * `checkStringIds()` and `CoreFileService.isMalformedFileId()` applied as `length === 24 && isValid()`.
 */
export function isWellFormedId(value: unknown): boolean {
  if (typeof value === 'string') {
    return STORED_ID.test(value);
  }
  return isObjectIdLike(value);
}
