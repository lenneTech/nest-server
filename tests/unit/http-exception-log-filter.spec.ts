import { BadRequestException, ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpExceptionLogFilter } from '../../src/core/common/filters/http-exception-log.filter';

/**
 * `HttpExceptionLogFilter` answers a REST request with the exception's own fields. Those include `options` — and with
 * it the `cause` a caller passed (`new BadRequestException('…', { cause: dbError })`), which is meant for the log, not
 * for the client: an internal error, a query, a connection string. nest-server-starter registers the filter whenever
 * `logExceptions` is on (its default).
 */
function restHost() {
  const res = { json: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  const host = { getType: () => 'http', switchToHttp: () => ({ getResponse: () => res }) } as any;
  return { host, res };
}

describe('HttpExceptionLogFilter response body', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * @regression   the REST body spread the whole exception, so `options` and the `cause` passed to it reached the
   *   client: an internal error message, a query or a connection string, whatever the throwing code attached.
   * @seen-failing Serialize `{ ...exception }` unchanged in src/core/common/filters/http-exception-log.filter.ts —
   *   registered as mutation `http-exception-filter-sends-cause` in tests/regression-mutations.json.
   */
  it('sends neither options nor cause to the client', () => {
    const { host, res } = restHost();
    const cause = new Error('connect mongodb://admin:s3cret@db.internal:27017 failed');
    new HttpExceptionLogFilter().catch(
      new BadRequestException('Invalid input', { cause, description: 'detail' }),
      host,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body).not.toHaveProperty('options');
    expect(body).not.toHaveProperty('cause');
    expect(JSON.stringify(body)).not.toContain('s3cret');
    expect(JSON.stringify(body)).not.toContain('db.internal');
  });

  it('keeps the shape clients read: response, status, message, name', () => {
    const { host, res } = restHost();
    new HttpExceptionLogFilter().catch(new ForbiddenException('#LTNS_0001: Access denied'), host);

    const body = res.json.mock.calls[0][0];
    expect(body).toMatchObject({
      message: '#LTNS_0001: Access denied',
      name: 'ForbiddenException',
      response: { error: 'Forbidden', message: '#LTNS_0001: Access denied', statusCode: 403 },
      status: 403,
    });
  });

  it('answers a ServiceUnavailableException with its response, as before', () => {
    const { host, res } = restHost();
    const exception = new ServiceUnavailableException({ details: { db: 'down' }, status: 'error' });
    new HttpExceptionLogFilter().catch(exception, host);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ details: { db: 'down' }, status: 'error' });
  });

  it('returns the exception unchanged for GraphQL', () => {
    const exception = new BadRequestException('Invalid input', { cause: new Error('internal') });
    const host = { getType: () => 'graphql' } as any;
    expect(new HttpExceptionLogFilter().catch(exception, host)).toBe(exception);
  });
});
