import { isObjectIdLike } from '../../helpers/id.helper.js';
import type { FieldDescriptor, FieldKind } from '../model-descriptor.interface.js';
import { QueryCastError } from './sql-errors.js';

/**
 * Cast a filter value to its field's type with Mongoose's query-casting rules (`mongoose/lib/cast/*.js`), so a SQL
 * store answers the filter MongoDB would answer: `'5'` matches the number 5, `'2026-01-01'` a date, an ObjectId its
 * hex id, and `'yes'` a boolean `true`. A value Mongoose refuses with a `CastError` is refused here with a
 * `QueryCastError`.
 *
 * `setters` mirrors Mongoose applying a string path's `lowercase` / `trim` setters to query values — to equality, `$in`
 * and comparisons, never to `$regex`.
 *
 * Returns `null` for `null`, `undefined` and the empty string where Mongoose does.
 */
export function castFilterValue(field: FieldDescriptor, path: string, value: unknown, setters = true): unknown {
  const kind: FieldKind = field.kind === 'enum' ? (field.enumBase ?? 'string') : field.kind;
  switch (kind) {
    case 'bigint':
      return castBigInt(path, value);
    case 'boolean':
      return castBoolean(path, value);
    case 'date':
      return castDate(path, value);
    case 'decimal':
      return castDecimal(path, value);
    case 'id':
      return castObjectId(path, value);
    case 'number':
      return castNumber(path, value);
    case 'ref':
      return castRef(path, value);
    case 'string':
      return castString(field, path, value, setters);
    case 'uuid':
      return castUuid(path, value);
    default:
      // json, object, buffer: stored as they are, compared as they are
      return value === undefined ? null : value;
  }
}

function castNumber(path: string, value: unknown): null | number {
  if (isNullish(value) || value === '') {
    return null;
  }
  const result =
    typeof value === 'string' || typeof value === 'boolean'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : isBoxedNumber(value)
          ? Number(value)
          : Number.NaN;
  if (Number.isNaN(result)) {
    throw new QueryCastError(path, 'Number', value);
  }
  return result;
}

const TRUE_VALUES = new Set<unknown>([true, 'true', 1, '1', 'yes']);
const FALSE_VALUES = new Set<unknown>([false, 'false', 0, '0', 'no']);

function castBoolean(path: string, value: unknown): boolean | null {
  if (TRUE_VALUES.has(value)) {
    return true;
  }
  if (FALSE_VALUES.has(value)) {
    return false;
  }
  if (isNullish(value)) {
    return null;
  }
  throw new QueryCastError(path, 'Boolean', value);
}

function castDate(path: string, value: unknown): Date | null {
  if (isNullish(value) || value === '') {
    return null;
  }
  if (typeof value === 'boolean') {
    throw new QueryCastError(path, 'Date', value);
  }
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number' || isBoxedNumber(value)) {
    date = new Date(Number(value));
  } else if (typeof value === 'string' && !Number.isNaN(Number(value))) {
    // Mongoose reads a numeric string as milliseconds only outside the range of a year
    const asNumber = Number(value);
    date = asNumber >= 275761 || asNumber < -271820 ? new Date(asNumber) : new Date(value);
  } else if (typeof value === 'string') {
    date = new Date(value);
  } else {
    throw new QueryCastError(path, 'Date', value);
  }
  if (Number.isNaN(date.valueOf())) {
    throw new QueryCastError(path, 'Date', value);
  }
  return date;
}

function castString(field: FieldDescriptor, path: string, value: unknown, setters: boolean): null | string {
  if (isNullish(value)) {
    return null;
  }
  let result: string;
  if (typeof (value as { _id?: unknown })._id === 'string') {
    result = (value as { _id: string })._id;
  } else if (
    typeof value === 'string' ||
    (typeof (value as { toString?: unknown }).toString === 'function' &&
      (value as object).toString !== Object.prototype.toString &&
      !Array.isArray(value))
  ) {
    result = String(value);
  } else {
    throw new QueryCastError(path, 'String', value);
  }
  if (setters) {
    if (field.lowercase) {
      result = result.toLowerCase();
    }
    if (field.trim) {
      result = result.trim();
    }
  }
  return result;
}

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** ids are stored as lowercase ObjectId hex (plan §3.5) */
function castObjectId(path: string, value: unknown): null | string {
  if (isNullish(value)) {
    return null;
  }
  const candidate = idCandidate(value);
  if (typeof candidate === 'string' && OBJECT_ID_HEX.test(candidate)) {
    return candidate.toLowerCase();
  }
  throw new QueryCastError(path, 'ObjectId', value);
}

/**
 * A reference column holds the referenced record's id. Unlike `_id`, a reference may be declared as a string, so any
 * string is a valid value; an ObjectId or a record becomes its hex id.
 */
function castRef(path: string, value: unknown): null | string {
  if (isNullish(value)) {
    return null;
  }
  const candidate = idCandidate(value);
  if (typeof candidate === 'string') {
    return OBJECT_ID_HEX.test(candidate) ? candidate.toLowerCase() : candidate;
  }
  throw new QueryCastError(path, 'ObjectId', value);
}

function idCandidate(value: unknown): unknown {
  if (isObjectIdLike(value)) {
    return value.toHexString();
  }
  if (typeof value === 'string') {
    return value;
  }
  const nested = (value as { _id?: unknown; id?: unknown })?._id ?? (value as { id?: unknown })?.id;
  if (isObjectIdLike(nested)) {
    return nested.toHexString();
  }
  return typeof nested === 'string' ? nested : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(path: string, value: unknown): null | string {
  if (isNullish(value)) {
    return null;
  }
  const text = typeof value === 'string' ? value : String((value as { toString?: () => string })?.toString?.());
  if (UUID.test(text)) {
    return text.toLowerCase();
  }
  throw new QueryCastError(path, 'UUID', value);
}

/** bigint values travel as text and are cast by Postgres, so no precision is lost on the way */
function castBigInt(path: string, value: unknown): null | string {
  if (isNullish(value) || value === '') {
    return null;
  }
  try {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'number' && Number.isInteger(value)) {
      return BigInt(value).toString();
    }
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
      return BigInt(value.trim()).toString();
    }
  } catch {
    // fall through
  }
  throw new QueryCastError(path, 'BigInt', value);
}

function castDecimal(path: string, value: unknown): null | string {
  if (isNullish(value) || value === '') {
    return null;
  }
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : String(value);
  if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) {
    return text;
  }
  throw new QueryCastError(path, 'Decimal128', value);
}

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** `new Number(5)`, which Mongoose accepts too */
function isBoxedNumber(value: unknown): boolean {
  return Object.prototype.toString.call(value) === '[object Number]' && typeof value === 'object';
}
