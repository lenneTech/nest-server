import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Error as MongooseError } from 'mongoose';

import { ErrorCode } from '../../modules/error-code/error-codes.js';
import { QueryCastError } from '../persistence/sql/sql-errors.js';

import type { GqlContextType } from '@nestjs/graphql';
import type { Request, Response } from 'express';

/**
 * Where the value of a failed Mongoose cast came from — and therefore who is at fault.
 *
 * - `identifier`: it names the resource the request addresses — a route parameter, or a top-level
 *   GraphQL argument. A malformed identifier names nothing, so it is answered like an unknown one: 404.
 * - `input`: the client sent it as data — query string, body, or nested inside a GraphQL input: 400.
 * - `server`: the request does not contain it. It came from stored data or from server code, which is
 *   a data or code defect and stays a 500, so monitoring keeps seeing it.
 */
export type CastErrorOrigin = 'identifier' | 'input' | 'server';

/**
 * Bounds for walking request data. They keep error handling cheap and terminating for a deeply nested,
 * very wide or self-referencing structure — the body parser's size limit alone does not: a project may
 * raise it, and a few megabytes of `[0,0,0,…]` are a million nodes. What the budget cannot reach is not
 * matched, which answers `server` (a 500), the status quo — never a client error.
 */
const MAX_WALK_DEPTH = 32;
const MAX_WALK_NODES = 10_000;

type Primitive = bigint | boolean | number | string;

function isPrimitive(value: unknown): value is Primitive {
  return (
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
  );
}

/**
 * The strings a CastError's `value` stands for.
 *
 * A primitive stands for itself, an array (the `$in` shape) for each of its primitive elements.
 * Anything else yields nothing: the strings inside an object cast as a whole (a subdocument, a whole
 * array of them) are not what failed, and matching them against the request would relabel a server
 * defect as a client error whenever one of them happens to appear in the body.
 */
export function castErrorCandidates(value: unknown): string[] {
  if (isPrimitive(value)) {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.filter(isPrimitive).map((item) => String(item));
  }
  return [];
}

/**
 * The children of an array or object, or `undefined` when there are more than `room` of them.
 *
 * Never collects more than `room` entries: an object is read key by key rather than through
 * `Object.values()`, which would first copy every value of a million-key object.
 */
function boundedChildren(value: object, room: number): readonly unknown[] | undefined {
  if (Array.isArray(value)) {
    return value.length > room ? undefined : value;
  }
  const children: unknown[] = [];
  // Own enumerable keys only, as Object.values — also for the null-prototype objects Express's query
  // parser and graphql-js produce, which is why hasOwnProperty is borrowed rather than called
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    if (children.length >= room) {
      return undefined;
    }
    children.push((value as Record<string, unknown>)[key]);
  }
  return children;
}

/**
 * Whether one of `candidates` occurs as a primitive anywhere in `source` (compared as strings, so a
 * number in a JSON body matches the number Mongoose failed to cast). Depth- and size-bounded, and
 * safe against cycles.
 *
 * The node budget is checked BEFORE a container's children are queued, not when they are visited: a
 * container the remaining budget cannot hold is skipped as a whole. Queuing first and counting later
 * let `{ ids: ['bad'], pad: [<a million zeros>] }` allocate a million stack entries and then give up
 * before reaching `ids` — a 400 answered as a 500 after half a second of blocked event loop. Skipping
 * (rather than queuing the first few) also leaves the budget to the oversized container's siblings.
 */
export function containsCastValue(source: unknown, candidates: readonly string[]): boolean {
  if (!candidates.length) {
    return false;
  }
  const wanted = new Set(candidates);
  const seen = new Set<object>();
  const stack: { depth: number; value: unknown }[] = [{ depth: 0, value: source }];
  let nodes = 0;
  for (let item = stack.pop(); item; item = stack.pop()) {
    const { depth, value } = item;
    // Unreachable while boundedChildren() keeps the invariant below; kept so that a regression there
    // degrades to a 500 instead of an unbounded walk
    if (++nodes > MAX_WALK_NODES) {
      return false;
    }
    if (isPrimitive(value)) {
      if (wanted.has(String(value))) {
        return true;
      }
      continue;
    }
    if (!value || typeof value !== 'object' || depth >= MAX_WALK_DEPTH || ArrayBuffer.isView(value)) {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    // nodes + stack.length never exceeds MAX_WALK_NODES: only what the budget can still hold is queued
    const children = boundedChildren(value, MAX_WALK_NODES - nodes - stack.length);
    for (const child of children ?? []) {
      stack.push({ depth: depth + 1, value: child });
    }
  }
  return false;
}

/**
 * Whether one of `candidates` is one of `values` itself, or an element of an array among them — the
 * shape of route parameters (Express 5 wildcards are arrays) and of top-level GraphQL arguments.
 */
function isDirectValue(values: readonly unknown[], candidates: readonly string[]): boolean {
  const wanted = new Set(candidates);
  const matches = (value: unknown) => isPrimitive(value) && wanted.has(String(value));
  // A list beyond the walk budget is not scanned here either — a GraphQL list argument is client-sized
  return values.some((value) =>
    Array.isArray(value) ? value.length <= MAX_WALK_NODES && value.some(matches) : matches(value),
  );
}

/**
 * Classify a CastError raised while handling a REST request.
 *
 * A value that is a route parameter is an `identifier`; one found anywhere in the query string or the
 * body is `input`; anything else is `server`. The parameter check runs first, so `PATCH /x/:id` with the
 * same malformed id in its body is still a 404.
 */
export function classifyHttpCastError(
  value: unknown,
  request: Partial<Pick<Request, 'body' | 'params' | 'query'>> | undefined,
): CastErrorOrigin {
  const candidates = castErrorCandidates(value);
  if (!candidates.length || !request) {
    return 'server';
  }
  if (isDirectValue(Object.values(request.params ?? {}), candidates)) {
    return 'identifier';
  }
  if (containsCastValue(request.query, candidates) || containsCastValue(request.body, candidates)) {
    return 'input';
  }
  return 'server';
}

/**
 * Classify a CastError raised while executing a GraphQL field.
 *
 * The GraphQL counterpart of a route parameter is a top-level scalar argument (`getUser(id: …)`), and
 * of a body a value nested inside an input object (`findUsers(filter: …)`, `updateUser(input: …)`).
 */
export function classifyGraphQlCastError(value: unknown, args: unknown): CastErrorOrigin {
  const candidates = castErrorCandidates(value);
  if (!candidates.length || !args || typeof args !== 'object') {
    return 'server';
  }
  if (isDirectValue(Object.values(args), candidates)) {
    return 'identifier';
  }
  if (containsCastValue(args, candidates)) {
    return 'input';
  }
  return 'server';
}

/**
 * Answers a Mongoose `CastError` caused by the CLIENT as a client error instead of a 500.
 *
 * A malformed id in a route parameter (`GET /users/not-an-id`) reaches Mongoose, which throws
 * `CastError`. That is not an `HttpException`, so it escaped every `@Catch(HttpException)` filter and Nest
 * answered **500 Internal server error** for what is simply "this resource does not exist".
 *
 * | Value of the failed cast | REST | GraphQL |
 * |--------------------------|------|---------|
 * | a route parameter / a top-level argument | 404 `ErrorCode.RESOURCE_NOT_FOUND` | same |
 * | in the query string or the body / nested in an input | 400 `ErrorCode.INVALID_FIELD_FORMAT [path]` | same |
 * | not in the request (stored data, server code) | 500, exactly as before, logged as an error | unchanged |
 *
 * The third row is deliberate: a broken id in stored data or a cast on a server-computed value is a
 * defect, and relabelling it as a client error would hide it from monitoring.
 *
 * The Mongoose message is never sent: it names the model. Registered by `CoreModule` as `APP_FILTER`
 * (opt out with `security.mongooseCastErrorFilter: false`), so `main.ts` and test setups need no change.
 * A project's own catch-all filter registered via `app.useGlobalFilters()` is consulted first and wins.
 *
 * Only `CastError` is handled, and Mongoose raises it only while casting a QUERY or an UPDATE
 * (filters, `findById`, `findByIdAndUpdate` / `updateOne` — the path `CrudService.update()` takes). Two
 * neighbours stay a 500:
 * - a malformed id in a document being CREATED or SAVED (`new Model().save()`, `Model.create()`,
 *   `insertMany()` — the path `CrudService.create()` takes) arrives as a `ValidationError` wrapping the
 *   CastError. Validate reference ids in the input instead (`validator: () => [IsMongoId()]` on the
 *   `@UnifiedField`);
 * - a `BSONError` from `new Types.ObjectId(bad)` in service code carries no value to classify; such code
 *   should check the id itself (see `CoreFileService.isMalformedFileId()`).
 */
/** A cast failure from either store: Mongoose's `CastError`, or the SQL store's `QueryCastError` (same rules, same fields) */
export type CastFailure = MongooseError.CastError | QueryCastError;

@Catch(MongooseError.CastError, QueryCastError)
export class MongooseCastErrorFilter implements ExceptionFilter {
  protected static readonly logger = new Logger('MongooseCastErrorFilter');

  /**
   * The context Nest's own handler logs an unknown error under — so a cast failure that stays a 500 is
   * logged exactly as before this filter existed, and monitoring matching that line keeps matching.
   */
  protected static readonly unknownErrorLogger = new Logger('ExceptionsHandler');

  catch(exception: CastFailure, host: ArgumentsHost): HttpException | undefined {
    const type = host.getType<GqlContextType>();
    if (type === 'graphql') {
      return this.catchGraphQl(exception, host);
    }
    if (type === 'http') {
      this.catchHttp(exception, host);
    }
    // Any other transport: returning nothing hands the error back to its own exception handler
    return undefined;
  }

  /**
   * GraphQL: the returned exception becomes the field error. Returning nothing hands the error back to
   * Nest's external exception handler, which logs and rethrows it — what happened before this filter.
   */
  protected catchGraphQl(exception: CastFailure, host: ArgumentsHost): HttpException | undefined {
    const origin = classifyGraphQlCastError(exception.value, host.getArgByIndex(1));
    if (origin === 'server') {
      return undefined;
    }
    return this.toHttpException(exception, origin);
  }

  /**
   * REST: a filter that matched must answer the request itself — Nest does not fall back to its own
   * handler afterwards.
   */
  protected catchHttp(exception: CastFailure, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const origin = classifyHttpCastError(exception.value, ctx.getRequest<Request>());
    if (origin === 'server') {
      this.replyAsUnknownError(exception, response);
      return;
    }
    const httpException = this.toHttpException(exception, origin);
    if (response.headersSent) {
      response.end();
      return;
    }
    // Same wire shape as HttpExceptionLogFilter, so a client sees one error format for every 4xx
    response.status(httpException.getStatus()).json({ ...httpException });
  }

  /**
   * The client error a request-supplied cast failure is answered with. The Mongoose message stays in
   * the server log (debug level): it names the model, which is none of the client's business.
   */
  protected toHttpException(exception: CastFailure, origin: 'identifier' | 'input'): HttpException {
    MongooseCastErrorFilter.logger.debug(
      `Cast failed on a value from the request (${origin === 'identifier' ? 404 : 400}): ${exception.message}`,
    );
    if (origin === 'identifier') {
      return new NotFoundException(ErrorCode.RESOURCE_NOT_FOUND);
    }
    return new BadRequestException(
      exception.path ? `${ErrorCode.INVALID_FIELD_FORMAT} [${exception.path}]` : ErrorCode.INVALID_FIELD_FORMAT,
    );
  }

  /**
   * What Nest's `BaseExceptionFilter` does with an error it does not know: the generic 500 body, and
   * the error object itself in the log — `logger.error(exception)`, the same call Nest 11 makes, so the
   * line (and its JSON form under a JSON logger) is the one monitoring already sees.
   */
  protected replyAsUnknownError(exception: Error, response: Response): void {
    if (response.headersSent) {
      response.end();
    } else {
      response
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' });
    }
    MongooseCastErrorFilter.unknownErrorLogger.error(exception);
  }
}
