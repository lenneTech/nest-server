import { UnsupportedQueryError } from './sql-errors.js';

/**
 * Identifier rules shared by the query compiler and the schema compiler: one mapping from a model's field name to
 * its column, and one place that decides what may become an identifier at all.
 *
 * Identifiers never come from a request: every name is looked up in the model descriptor first. This module is the
 * second line — whatever reaches `quoteIdentifier()` must still look like an identifier, or it is refused.
 */

const IDENTIFIER = /^[A-Za-z_]\w*$/;
/** Postgres truncates longer identifiers silently, which would let two names address one column */
const MAX_IDENTIFIER_LENGTH = 63;

/**
 * Names that address JavaScript's object machinery rather than data. Mongoose ignores them in a path; a compiler that
 * builds an object from path segments would otherwise reach `Object.prototype` through them
 */
const RESERVED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** A field-name or path segment as the query language accepts it: no dots, no `$`, no leading digit, no prototype name. */
export function isPathSegment(segment: string): boolean {
  return IDENTIFIER.test(segment) && !RESERVED_SEGMENTS.has(segment);
}

/** The column of a field: `_id` / `id` → `id`, camelCase → snake_case (`createdAt` → `created_at`, `userID` → `user_id`). */
export function columnName(field: string): string {
  if (field === '_id' || field === 'id') {
    return 'id';
  }
  if (!IDENTIFIER.test(field)) {
    throw new UnsupportedQueryError(`"${field}" cannot be mapped to a column`);
  }
  return field
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** Double-quote an identifier after checking it is one. */
export function quoteIdentifier(name: string): string {
  if (!IDENTIFIER.test(name) || name.length > MAX_IDENTIFIER_LENGTH) {
    throw new UnsupportedQueryError(`"${name}" is not a valid SQL identifier`);
  }
  return `"${name}"`;
}

/**
 * Backtick-quote an identifier for MySQL / MariaDB after checking it is one — with the same limit as PostgreSQL's
 * (MySQL allows 64), so a model's names are valid on every SQL database alike.
 */
export function quoteMysqlIdentifier(name: string): string {
  if (!IDENTIFIER.test(name) || name.length > MAX_IDENTIFIER_LENGTH) {
    throw new UnsupportedQueryError(`"${name}" is not a valid SQL identifier`);
  }
  return `\`${name}\``;
}

/** Where a compiler puts a value: a bound parameter, or — for DDL, which has none — a literal. */
export interface SqlParamSink {
  /** Returns the SQL that stands for `value` */
  add(value: unknown): string;
}

/** Positional parameters of one statement (`$1`, `$2`, …), shared by every part that contributes to it. */
export class SqlParams implements SqlParamSink {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * Values as SQL literals, for the one place that cannot bind parameters: DDL (a partial index predicate, a column
 * default). Only values the code declares reach it — schema options, never request data — and every literal is an
 * escape-string (`E'…'`), so backslashes and quotes mean the same whatever `standard_conforming_strings` says.
 */
export class SqlLiterals implements SqlParamSink {
  add(value: unknown): string {
    return sqlLiteral(value);
  }
}

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new UnsupportedQueryError('A literal number must be finite');
    }
    return String(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return escapeString(value.toISOString());
  }
  if (Array.isArray(value)) {
    return escapeString(`{${value.map(arrayElement).join(',')}}`);
  }
  if (typeof value === 'string') {
    return escapeString(value);
  }
  throw new UnsupportedQueryError('A value of this type cannot be written as a SQL literal');
}

function arrayElement(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  const text = value instanceof Date ? value.toISOString() : value;
  if (typeof text !== 'string') {
    throw new UnsupportedQueryError('Only scalar arrays can be written as a SQL literal');
  }
  return `"${text.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

function escapeString(text: string): string {
  if (text.includes('\0')) {
    throw new UnsupportedQueryError('A SQL literal cannot contain a NUL character');
  }
  return `E'${text.replace(/[\\']/g, (char) => `\\${char}`)}'`;
}
