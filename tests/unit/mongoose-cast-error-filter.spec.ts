/**
 * MongooseCastErrorFilter — who sent the value that failed to cast?
 *
 * The filter turns a Mongoose `CastError` into 404 or 400 only when the failing value demonstrably came
 * from the request. Getting that classification wrong is not symmetric:
 *
 * - a client value classified as `server` keeps the old 500 — the status quo, annoying but visible;
 * - a server value classified as client input relabels a data or code defect as a 4xx and hides it
 *   from monitoring.
 *
 * So the cases below pin the positive matches AND the refusals (objects cast as a whole, values that
 * only resemble request data, exhausted walk budgets) that keep the second mistake from happening.
 * The end-to-end half — the filter registered by `CoreModule` against real routes — is
 * `tests/mongoose-cast-error.e2e-spec.ts`.
 */
import { ArgumentsHost, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import {
  castErrorCandidates,
  classifyGraphQlCastError,
  classifyHttpCastError,
  containsCastValue,
  MongooseCastErrorFilter,
} from '../../src/core/common/filters/mongoose-cast-error.filter';
import { QueryCastError } from '../../src/core/common/persistence/sql/sql-errors';
import { ErrorCode } from '../../src/core/modules/error-code/error-codes';
import { captureExpectedLogs } from '../helpers/expected-log-output';

const probeSchema = new mongoose.Schema({ owner: { type: mongoose.Schema.Types.ObjectId } });
// A distinctive model name: the client must never see it, and the assertions below search for it
const ProbeModel: mongoose.Model<any> =
  mongoose.models.SecretProbeModelName || mongoose.model('SecretProbeModelName', probeSchema);

/** A real CastError, produced by Mongoose's own query casting — not a hand-built imitation. */
function castErrorFor(filter: Record<string, unknown>): mongoose.Error.CastError {
  try {
    // Query#cast() runs the cast a query would run before it is sent; its typings do not declare a plain filter
    (ProbeModel.find() as any).cast(ProbeModel, filter);
  } catch (error) {
    if (error instanceof mongoose.Error.CastError) {
      return error;
    }
    throw error;
  }
  throw new Error(`Filter ${JSON.stringify(filter)} did not fail to cast`);
}

/** `length` copies of `value` — the padding shapes the walk budget has to cope with. */
function filled<T>(length: number, value: T): T[] {
  return Array.from({ length }, () => value);
}

function httpHost(request: Record<string, unknown>, headersSent = false) {
  const response = {
    body: undefined as unknown,
    end: vi.fn(),
    headersSent,
    json: vi.fn(function (this: any, body: unknown) {
      response.body = body;
      return response;
    }),
    statusCode: undefined as number | undefined,
    status: vi.fn(function (this: any, code: number) {
      response.statusCode = code;
      return response;
    }),
  };
  const host = {
    getArgByIndex: (index: number) => [request, response][index],
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

function graphQlHost(args: Record<string, unknown>) {
  return {
    getArgByIndex: (index: number) => [undefined, args, {}, {}][index],
    getType: () => 'graphql',
  } as unknown as ArgumentsHost;
}

describe('castErrorCandidates', () => {
  it('stands a primitive for itself, as a string', () => {
    expect(castErrorCandidates('upcoming-birthdays')).toEqual(['upcoming-birthdays']);
    expect(castErrorCandidates(5)).toEqual(['5']);
  });

  it('stands an array (the $in shape) for each primitive element', () => {
    expect(castErrorCandidates(['a', 2, { nested: 'x' }])).toEqual(['a', '2']);
  });

  it('yields nothing for an object cast as a whole, so its inner strings cannot match the request', () => {
    expect(castErrorCandidates({ name: 'Alice' })).toEqual([]);
    expect(castErrorCandidates(undefined)).toEqual([]);
    expect(castErrorCandidates(null)).toEqual([]);
  });
});

describe('containsCastValue', () => {
  it('finds a value nested in objects and arrays, including null-prototype objects', () => {
    const query = Object.assign(Object.create(null), { filter: { owners: ['x', 'bad'] } });
    expect(containsCastValue(query, ['bad'])).toBe(true);
    expect(containsCastValue({ a: [{ b: { c: 'bad' } }] }, ['bad'])).toBe(true);
  });

  it('compares as strings, so a JSON number matches the number Mongoose failed to cast', () => {
    expect(containsCastValue({ owner: 5 }, ['5'])).toBe(true);
  });

  it('refuses what is not there', () => {
    expect(containsCastValue({ a: 'good', b: ['other'] }, ['bad'])).toBe(false);
    expect(containsCastValue(undefined, ['bad'])).toBe(false);
    expect(containsCastValue({ a: 'bad' }, [])).toBe(false);
  });

  it('terminates on a cycle', () => {
    const body: Record<string, unknown> = { a: 'good' };
    body.self = body;
    expect(containsCastValue(body, ['bad'])).toBe(false);
  });

  it('does not read binary data as a list of numbers', () => {
    expect(containsCastValue({ file: Buffer.from([5]) }, ['5'])).toBe(false);
  });

  /**
   * @regression   11.42.16 (pre-release) — the node budget was checked when a node was VISITED, while
   *   every child was queued unchecked. A wide array as the last body key was expanded completely
   *   first: `{ ids: ['bad'], pad: [<7.4 million zeros>] }` blocked the event loop for ~400 ms, took
   *   ~385 MB of heap, and then gave up before reaching `ids` — a 400 answered as a 500.
   * @seen-failing Let boundedChildren() in src/core/common/filters/mongoose-cast-error.filter.ts
   *   return an array whatever its length — registered as mutation `cast-error-walk-array-unbounded`
   *   in tests/regression-mutations.json; the object half as `cast-error-walk-object-unbounded`.
   */
  it('skips a container wider than the remaining budget as a whole, so its siblings are still visited', () => {
    expect(containsCastValue({ ids: ['bad'], pad: filled(1_000_000, 0) }, ['bad'])).toBe(true);

    const wideObject = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, 0]));
    expect(containsCastValue({ ids: ['bad'], pad: wideObject }, ['bad'])).toBe(true);
  });

  it('does not look inside a container too wide for the budget (the value stays a 500)', () => {
    expect(containsCastValue({ pad: [...filled(20_000, 0), 'bad'] }, ['bad'])).toBe(false);
  });

  it('gives up (answers false, i.e. a 500) beyond its depth budget instead of walking forever', () => {
    let deep: Record<string, unknown> = { value: 'bad' };
    for (let i = 0; i < 40; i++) {
      deep = { next: deep };
    }
    expect(containsCastValue(deep, ['bad'])).toBe(false);
  });
});

describe('classifyHttpCastError', () => {
  it('classifies a route parameter as identifier (404)', () => {
    expect(classifyHttpCastError('upcoming-birthdays', { params: { id: 'upcoming-birthdays' } })).toBe('identifier');
  });

  it('classifies an element of an Express 5 wildcard parameter as identifier', () => {
    expect(classifyHttpCastError('bad', { params: { path: ['files', 'bad'] } })).toBe('identifier');
  });

  it('prefers the route parameter when the same value is also in the body', () => {
    expect(classifyHttpCastError('bad', { body: { id: 'bad' }, params: { id: 'bad' } })).toBe('identifier');
  });

  it('classifies a query string value as input (400)', () => {
    expect(classifyHttpCastError('bad', { params: {}, query: { owner: 'bad' } })).toBe('input');
  });

  it('classifies a nested body value as input, also for the $in array shape', () => {
    expect(classifyHttpCastError('bad', { body: { filter: { owners: ['ok', 'bad'] } }, params: {} })).toBe('input');
    expect(classifyHttpCastError(['bad'], { body: { owners: ['bad'] }, params: {} })).toBe('input');
  });

  it('classifies a body value as input even next to a padding array of a million entries', () => {
    expect(classifyHttpCastError('bad', { body: { ids: ['bad'], pad: filled(1_000_000, 0) } })).toBe('input');
  });

  it('classifies a number sent in the body as input', () => {
    expect(classifyHttpCastError(5, { body: { owner: 5 } })).toBe('input');
  });

  /**
   * @regression   11.42.16 (pre-release) — the refusal half: a cast that fails on a value the request
   *   does not contain is a data or code defect. Relabelled as client input it answers 400 and
   *   disappears from monitoring.
   * @seen-failing Make the query/body branch of classifyHttpCastError() in
   *   src/core/common/filters/mongoose-cast-error.filter.ts match unconditionally — registered as
   *   mutation `cast-error-server-value-relabelled-unit` in tests/regression-mutations.json.
   */
  it('keeps a value the request does not contain a server error (500)', () => {
    expect(classifyHttpCastError('stored-broken-id', { body: { a: 'x' }, params: { id: 'y' }, query: {} })).toBe(
      'server',
    );
  });

  it('keeps an object cast as a whole a server error, even when its strings appear in the request', () => {
    expect(classifyHttpCastError({ name: 'Alice' }, { body: { name: 'Alice' } })).toBe('server');
  });

  it('keeps a missing request a server error', () => {
    expect(classifyHttpCastError('bad', undefined)).toBe('server');
  });
});

describe('classifyGraphQlCastError', () => {
  it('classifies a top-level argument (and an element of a top-level list) as identifier', () => {
    expect(classifyGraphQlCastError('bad', { id: 'bad' })).toBe('identifier');
    expect(classifyGraphQlCastError('bad', { ids: ['ok', 'bad'] })).toBe('identifier');
  });

  it('classifies a value nested in an input object as input', () => {
    expect(classifyGraphQlCastError('bad', { id: 'ok', input: { owner: 'bad' } })).toBe('input');
  });

  it('does not scan a top-level list longer than the walk budget', () => {
    expect(classifyGraphQlCastError('bad', { ids: [...filled(20_000, 'x'), 'bad'] })).toBe('server');
  });

  it('keeps a value the arguments do not contain a server error', () => {
    expect(classifyGraphQlCastError('bad', { id: 'ok' })).toBe('server');
    expect(classifyGraphQlCastError('bad', undefined)).toBe('server');
  });
});

describe('MongooseCastErrorFilter', () => {
  const filter = new MongooseCastErrorFilter();

  it('answers a malformed route parameter with 404 and the HttpExceptionLogFilter wire shape', () => {
    const exception = castErrorFor({ _id: 'upcoming-birthdays' });
    const { host, response } = httpHost({ body: {}, params: { id: 'upcoming-birthdays' }, query: {} });

    filter.catch(exception, host);

    expect(response.statusCode).toBe(HttpStatus.NOT_FOUND);
    expect(response.body).toEqual({ ...new NotFoundException(ErrorCode.RESOURCE_NOT_FOUND) });
    expect(JSON.stringify(response.body)).not.toContain('SecretProbeModelName');
  });

  it('answers a malformed body value with 400 naming the field, but not the model', () => {
    const exception = castErrorFor({ owner: 'bad' });
    const { host, response } = httpHost({ body: { owner: 'bad' }, params: { id: '507f1f77bcf86cd799439011' } });

    filter.catch(exception, host);

    expect(response.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect((response.body as any).message).toBe(`${ErrorCode.INVALID_FIELD_FORMAT} [owner]`);
    expect(JSON.stringify(response.body)).not.toContain('SecretProbeModelName');
  });

  it('answers the SQL store’s QueryCastError by the same rule (route 404, body 400, never the model)', () => {
    const route = httpHost({ body: {}, params: { id: 'upcoming-birthdays' }, query: {} });
    filter.catch(new QueryCastError('id', 'ObjectId', 'upcoming-birthdays'), route.host);
    expect(route.response.statusCode).toBe(HttpStatus.NOT_FOUND);

    const body = httpHost({ body: { owner: 'bad' }, params: {} });
    filter.catch(new QueryCastError('owner', 'ObjectId', 'bad'), body.host);
    expect(body.response.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect((body.response.body as any).message).toBe(`${ErrorCode.INVALID_FIELD_FORMAT} [owner]`);
  });

  it('answers a malformed body value with 400 even when the body also carries a huge padding array', () => {
    const exception = castErrorFor({ owner: 'bad' });
    const { host, response } = httpHost({ body: { owner: 'bad', pad: filled(1_000_000, 0) }, params: {} });

    filter.catch(exception, host);

    expect(response.statusCode).toBe(HttpStatus.BAD_REQUEST);
  });

  it('answers a value the request does not contain exactly like Nest did before: 500, logged with its stack', () => {
    const logged = captureExpectedLogs();
    const exception = castErrorFor({ _id: 'stored-broken-id' });
    const { host, response } = httpHost({ body: {}, params: { id: '507f1f77bcf86cd799439011' }, query: {} });

    filter.catch(exception, host);

    expect(response.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(response.body).toEqual({ message: 'Internal server error', statusCode: 500 });
    // The error object itself, as Nest 11's BaseExceptionFilter logs it — not a (message, stack) pair
    expect(logged).toEqual([String(exception)]);
  });

  it('logs the 500 under the context Nest itself uses for unknown errors', () => {
    const contexts: unknown[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation(function (this: any) {
      contexts.push(this.context);
    } as never);

    filter.catch(castErrorFor({ _id: 'stored-broken-id' }), httpHost({ params: {} }).host);

    expect(contexts).toEqual(['ExceptionsHandler']);
  });

  it('does not write a second response when headers are already sent', () => {
    const { host, response } = httpHost({ params: { id: 'bad' } }, true);

    filter.catch(castErrorFor({ _id: 'bad' }), host);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.end).toHaveBeenCalled();
  });

  it('returns a 404 exception for a malformed top-level GraphQL argument', () => {
    const result = filter.catch(castErrorFor({ _id: 'bad' }), graphQlHost({ id: 'bad' }));

    expect(result).toBeInstanceOf(NotFoundException);
    expect(result?.message).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });

  it('returns a 400 exception for a malformed value nested in a GraphQL input', () => {
    const result = filter.catch(castErrorFor({ owner: 'bad' }), graphQlHost({ input: { owner: 'bad' } }));

    expect(result?.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('hands a GraphQL cast failure on a server-side value back to Nest unchanged', () => {
    expect(filter.catch(castErrorFor({ _id: 'stored-broken-id' }), graphQlHost({ id: 'other' }))).toBeUndefined();
  });

  it('leaves other transports to their own exception handler', () => {
    const host = { getType: () => 'rpc' } as unknown as ArgumentsHost;
    expect(filter.catch(castErrorFor({ _id: 'bad' }), host)).toBeUndefined();
  });
});
