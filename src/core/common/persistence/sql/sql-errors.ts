import { BadRequestException } from '@nestjs/common';

/**
 * Errors of the SQL persistence layer.
 *
 * Neither message carries the offending VALUE: a filter value can be anything a request sent, including a
 * credential, and these messages travel into logs.
 */

/**
 * A filter, sort or update the SQL store cannot express. Thrown instead of dropping a condition (plan §3.2) —
 * a condition that silently disappears widens a query, which on a tenant- or owner-scoped read is a data leak.
 */
export class UnsupportedQueryError extends Error {
  override readonly name = 'UnsupportedQueryError';
}

/**
 * A filter value that cannot be cast to its field's type — the SQL counterpart of Mongoose's `CastError`, with the
 * same casting rules, so a value MongoDB refuses is refused on SQL too.
 */
export class QueryCastError extends Error {
  override readonly name = 'QueryCastError';

  /** The value that failed — not enumerable, so it never reaches a serialized error or a log line by accident */
  declare readonly value: unknown;

  constructor(
    readonly path: string,
    readonly kind: string,
    value?: unknown,
  ) {
    super(`Cast to ${kind} failed at path "${path}"`);
    Object.defineProperty(this, 'value', { enumerable: false, value });
  }
}

/**
 * A unique constraint refused a write — answered with 400. Carries MongoDB's duplicate-key code and message prefix,
 * because callers in the framework and in projects recognise a duplicate by `error.code === 11000` or by `E11000`.
 */
export class DuplicateKeyError extends BadRequestException {
  override readonly name = 'DuplicateKeyError';
  readonly code = 11000;

  /** `primaryKey`: the id itself is taken (an insert with a server id generates a new one, plan §3.3 E6) */
  constructor(
    readonly model: string,
    readonly primaryKey = false,
  ) {
    super(`E11000 duplicate key error: a unique value of ${model} already exists`);
  }
}
