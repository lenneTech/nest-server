import type { FieldDescriptor, FieldKind } from '../model-descriptor.interface.js';
import { UnsupportedQueryError } from './sql-errors.js';
import { isPathSegment } from './sql-naming.js';

/**
 * The dialect-free half of the filter compilers (`postgres/postgres-where.compiler.ts`, `mysql/mysql-where.compiler.ts`):
 * what a filter MEANS — which values are operator objects, which paths are valid, which BSON type a `$type` names — so
 * every SQL database reads a filter the same way and only the SQL it compiles to differs.
 */

export const SCALAR_KINDS = new Set<FieldKind>([
  'bigint',
  'boolean',
  'buffer',
  'date',
  'decimal',
  'enum',
  'id',
  'number',
  'ref',
  'string',
  'uuid',
]);
export const REGEX_KINDS = new Set<FieldKind>(['enum', 'ref', 'string']);
export const COMPARISON = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' } as const;
export type ComparisonOperator = keyof typeof COMPARISON;

export type BsonType = 'array' | 'bool' | 'date' | 'null' | 'number' | 'object' | 'objectId' | 'string';

const BSON_TYPE_ALIASES: Record<number | string, BsonType> = {
  1: 'number',
  10: 'null',
  16: 'number',
  18: 'number',
  19: 'number',
  2: 'string',
  3: 'object',
  4: 'array',
  7: 'objectId',
  8: 'bool',
  9: 'date',
  array: 'array',
  bool: 'bool',
  date: 'date',
  decimal: 'number',
  double: 'number',
  int: 'number',
  long: 'number',
  null: 'null',
  number: 'number',
  object: 'object',
  objectId: 'objectId',
  string: 'string',
};

/** Which column kinds hold a value of a BSON type */
export const COLUMN_TYPES: Partial<Record<BsonType, (field: FieldDescriptor) => boolean>> = {
  bool: (field) => field.kind === 'boolean',
  date: (field) => field.kind === 'date',
  number: (field) =>
    ['bigint', 'decimal', 'number'].includes(field.kind) || (field.kind === 'enum' && field.enumBase === 'number'),
  objectId: (field) => field.kind === 'id' || field.kind === 'ref',
  string: (field) => ['string', 'uuid'].includes(field.kind) || (field.kind === 'enum' && field.enumBase !== 'number'),
};

export function bsonType(path: string, value: unknown): BsonType {
  const type =
    (typeof value === 'string' || typeof value === 'number') &&
    Object.prototype.hasOwnProperty.call(BSON_TYPE_ALIASES, value)
      ? BSON_TYPE_ALIASES[value]
      : undefined;
  if (!type) {
    throw new UnsupportedQueryError(`$type ${JSON.stringify(value)} at "${path}"`);
  }
  return type;
}

export function splitPath(path: string): string[] {
  const segments = path.split('.');
  for (const segment of segments) {
    if (!isPathSegment(segment)) {
      throw new UnsupportedQueryError(`Invalid path "${path}"`);
    }
  }
  return segments;
}

export function itemOf(field: FieldDescriptor): FieldDescriptor {
  return { ...field, isArray: false };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** An object of operators. Mixing operators and fields is refused, as MongoDB refuses it. */
export function isOperatorObject(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  const operators = keys.filter((key) => key.startsWith('$')).length;
  if (operators && operators !== keys.length) {
    throw new UnsupportedQueryError('An object may not mix operators and fields');
  }
  return operators > 0;
}

/** JSON for a JSON parameter: dates as ISO strings and ids as hex (their `toJSON`), bigints as numbers or strings */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? (Number.isSafeInteger(Number(item)) ? Number(item) : item.toString()) : item,
  );
}
