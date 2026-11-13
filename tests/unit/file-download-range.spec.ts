/**
 * Byte ranges of a download: parsing the `Range` header, answering `206` / `416`, and the download routes passing
 * the range to the store.
 *
 * WHY: Safari refuses to play a video (and stalls audio) from a server that answers a `Range` request with `200` and
 * the whole file. Chrome plays it anyway, so a project that only tested in Chrome and Playwright shipped an
 * unplayable video — on S3, where the core had no way to read a range at all (12.9.1). The store side is proven per
 * driver in the file-storage parity matrix (`service.rangedRead`, `http.rangeRequests`); this file pins the HTTP
 * rules, which are the same for every store.
 */
import { HttpException } from '@nestjs/common';
import compression from 'compression';
import express from 'express';
import type { Response } from 'express';
import type { Server } from 'http';
import { request as httpRequest } from 'http';
import type { AddressInfo } from 'net';
import { PassThrough, Readable } from 'stream';
import { describe, expect, it } from 'vitest';

import { assertByteRange, parseRangeHeader } from '../../src/core/common/helpers/byte-range.helper';
import {
  CoreFileController,
  pipeFileToResponse,
  resolveDownloadRange,
  setDownloadRangeHeaders,
} from '../../src/core/modules/file/core-file.controller';
import type { CoreFileService } from '../../src/core/modules/file/core-file.service';
import { captureExpectedLogs } from '../helpers/expected-log-output';

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A response stub that records headers and status, with the request headers the helpers read */
function responseStub(requestHeaders: Record<string, string> = {}, headersSent = false) {
  const sink = new PassThrough();
  const headers: Record<string, string> = {};
  const calls = { json: undefined as unknown, removed: [] as string[], status: 0 };
  const res = Object.assign(sink, {
    destroy: () => res,
    getHeader: (name: string) => headers[name.toLowerCase()],
    header: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
      return res;
    },
    headersSent,
    json: (body: unknown) => {
      calls.json = body;
      return res;
    },
    removeHeader: (name: string) => {
      calls.removed.push(name);
      delete headers[name.toLowerCase()];
    },
    req: { headers: Object.fromEntries(Object.entries(requestHeaders).map(([k, v]) => [k.toLowerCase(), v])) },
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
      return res;
    },
    status: (code: number) => {
      calls.status = code;
      return res;
    },
  }) as unknown as Response;
  return { calls, headers, res };
}

describe('parseRangeHeader', () => {
  const length = 10_000;

  it('serves a single range, open-ended and suffix ranges, cut at the end of the file (RFC 9110 §14.1.2)', () => {
    expect(parseRangeHeader('bytes=0-499', length)).toEqual({ end: 499, start: 0 });
    expect(parseRangeHeader('bytes=500-999', length)).toEqual({ end: 999, start: 500 });
    expect(parseRangeHeader('bytes=0-0', length)).toEqual({ end: 0, start: 0 });
    expect(parseRangeHeader('bytes=9500-', length)).toEqual({ end: 9999, start: 9500 });
    expect(parseRangeHeader('bytes=-500', length)).toEqual({ end: 9999, start: 9500 });
    // Past the end: the rest of the file; a suffix longer than the file: all of it
    expect(parseRangeHeader('bytes=9000-20000', length)).toEqual({ end: 9999, start: 9000 });
    expect(parseRangeHeader('bytes=-20000', length)).toEqual({ end: 9999, start: 0 });
    // Safari's first request of a video
    expect(parseRangeHeader('bytes=0-1', length)).toEqual({ end: 1, start: 0 });
    // Unit case-insensitive, whitespace and empty list elements tolerated
    expect(parseRangeHeader('Bytes = 1 - 2', length)).toEqual({ end: 2, start: 1 });
    expect(parseRangeHeader('bytes=1-2,', length)).toEqual({ end: 2, start: 1 });
  });

  /**
   * @regression   12.9.3 — a range starting past the end of the file must be answered 416 with the real size, not
   *   with the whole file: a player that asked for the tail gets bytes from the start and decodes garbage.
   * @seen-failing Answer an unsatisfiable range with the whole file in parseRangeHeader()
   *   (src/core/common/helpers/byte-range.helper.ts) — registered as mutation `range-unsatisfiable-served-whole` in
   *   tests/regression-mutations.json.
   */
  it('reports a range starting at or past the end, a zero suffix, and every range of an empty file as unsatisfiable', () => {
    expect(parseRangeHeader('bytes=10000-', length)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=10000-10005', length)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=-0', length)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=0-', 0)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=-5', 0)).toBe('unsatisfiable');
  });

  it('answers the whole file for what it does not serve: no header, other units, invalid syntax, several ranges, unknown length', () => {
    for (const header of [
      undefined,
      '',
      'items=0-5',
      'bytes',
      'bytes=',
      'bytes=-',
      'bytes=5-2',
      'bytes=abc',
      'bytes=1.5-3',
      'bytes=0x10-20',
      'bytes=0-1,4-5',
      'bytes=0-1, -5',
      `bytes=${'9'.repeat(30)}-`,
      `bytes=${'0-1,'.repeat(100)}`,
    ]) {
      expect(parseRangeHeader(header, length), String(header)).toBeUndefined();
    }
    // A repeated header is a list of ranges
    expect(parseRangeHeader(['bytes=0-1', 'bytes=4-5'], length)).toBeUndefined();
    // A 206 must name the total length
    for (const unknown of [undefined, Number.NaN, -1, 1.5]) {
      expect(parseRangeHeader('bytes=0-1', unknown)).toBeUndefined();
    }
  });
});

describe('assertByteRange', () => {
  it('passes a valid range and no range, and refuses everything else with a RangeError', () => {
    expect(assertByteRange(undefined)).toBeUndefined();
    expect(assertByteRange({ end: 0, start: 0 })).toEqual({ end: 0, start: 0 });
    expect(assertByteRange({ end: 9, start: 3 })).toEqual({ end: 9, start: 3 });
    for (const range of [
      { end: 2, start: 5 },
      { end: 3, start: -1 },
      { end: 2, start: 0.5 },
      { end: Number.NaN, start: 0 },
      { start: 0 },
      { end: '9', start: '0' },
    ]) {
      expect(() => assertByteRange(range), JSON.stringify(range)).toThrow(RangeError);
    }
  });
});

describe('resolveDownloadRange', () => {
  it('returns the requested range of the file', () => {
    const { res } = responseStub({ Range: 'bytes=10-19' });
    expect(resolveDownloadRange(res, 100)).toEqual({ end: 19, start: 10 });
  });

  it('throws 416 with the real size for a range past the end', () => {
    const { headers, res } = responseStub({ Range: 'bytes=100-' });
    let thrown: unknown;
    try {
      resolveDownloadRange(res, 100);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(416);
    expect(String((thrown as HttpException).getResponse())).toContain('LTNS_0503');
    expect(headers['content-range']).toBe('bytes */100');
  });

  it('ignores the range under If-Range: the only validator is a weak ETag, which If-Range never matches', () => {
    const { res } = responseStub({ 'If-Range': 'W/"abc"', Range: 'bytes=0-1' });
    expect(resolveDownloadRange(res, 100)).toBeUndefined();
  });

  it('returns undefined without a Range header and without a request', () => {
    expect(resolveDownloadRange(responseStub().res, 100)).toBeUndefined();
    expect(resolveDownloadRange({} as Response, 100)).toBeUndefined();
  });
});

describe('setDownloadRangeHeaders', () => {
  it('answers a range with 206, Content-Range, the length of the range and no-transform', () => {
    const { calls, headers, res } = responseStub();
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Length', '100');
    setDownloadRangeHeaders(res, { end: 19, start: 10 }, 100);
    expect(calls.status).toBe(206);
    expect(headers['content-range']).toBe('bytes 10-19/100');
    expect(headers['content-length']).toBe('10');
    expect(headers['accept-ranges']).toBe('bytes');
    expect(headers['cache-control']).toBe('private, no-store, no-transform');
    // Applied twice it does not repeat the directive
    setDownloadRangeHeaders(res, { end: 19, start: 10 }, 100);
    expect(headers['cache-control']).toBe('private, no-store, no-transform');
  });

  it('only announces ranges for a whole file, and does nothing when the length is unknown', () => {
    const whole = responseStub();
    setDownloadRangeHeaders(whole.res, undefined, 100);
    expect(whole.calls.status).toBe(0);
    expect(whole.headers).toEqual({ 'accept-ranges': 'bytes' });

    const unknown = responseStub();
    setDownloadRangeHeaders(unknown.res, undefined, undefined);
    expect(unknown.headers).toEqual({});
  });

  it('names an unknown complete length with * in a 206', () => {
    const { calls, headers, res } = responseStub();
    setDownloadRangeHeaders(res, { end: 9, start: 5 }, undefined);
    expect(calls.status).toBe(206);
    expect(headers['content-range']).toBe('bytes 5-9/*');
    expect(headers['content-length']).toBe('5');
    expect(headers['accept-ranges']).toBeUndefined();
  });
});

describe('download routes with a Range header', () => {
  const file = { contentType: 'video/mp4', filename: 'clip.mp4', id: 'abc', length: 100 };

  function route(service: Partial<CoreFileService>, piped: Readable[]) {
    return Object.create(CoreFileController.prototype, {
      fileService: { value: service },
      pipeFileToResponse: { value: (stream: Readable, res: Response) => (piped.push(stream), res) },
    }) as CoreFileController;
  }

  /**
   * @regression   12.9.3 — the routes read and delivered the whole file for every `Range` request.
   * @seen-failing Let resolveDownloadRange() in src/core/modules/file/core-file.controller.ts ignore the header —
   *   registered as mutation `download-route-ignores-range` in tests/regression-mutations.json.
   */
  it('reads only the requested bytes from the known store and answers 206, on both routes', async () => {
    for (const byName of [false, true]) {
      const { calls, headers, res } = responseStub({ Range: 'bytes=0-1' });
      const opened: unknown[] = [];
      const piped: Readable[] = [];
      const controller = route(
        {
          getFileInfoByName: async () => file,
          getFileStream: async (...args: unknown[]) => {
            opened.push(args);
            return Readable.from([Buffer.from('ab')]);
          },
          resolveFile: async () => ({ info: file, store: 'gridfs' }),
        } as unknown as Partial<CoreFileService>,
        piped,
      );

      await (byName ? controller.getFile('clip.mp4', res) : controller.getFileById('abc', res));
      expect(piped).toHaveLength(1);
      expect(opened).toHaveLength(1);
      const [id, options, store] = opened[0] as [string, { range?: unknown }, string?];
      expect(id).toBe('abc');
      expect(options.range).toEqual({ end: 1, start: 0 });
      expect(store).toBe(byName ? undefined : 'gridfs');
      expect(calls.status).toBe(206);
      expect(headers['content-range']).toBe('bytes 0-1/100');
      expect(headers['content-length']).toBe('2');
      expect(headers['content-type']).toBe('video/mp4');
      expect(headers['cache-control']).toBe('private, no-store, no-transform');
    }
  });

  it('answers 416 after the rights check, without opening the store', async () => {
    const { headers, res } = responseStub({ Range: 'bytes=100-' });
    const order: string[] = [];
    const controller = route(
      {
        getFileStream: async () => {
          order.push('open');
          return Readable.from([]);
        },
        resolveFile: async () => {
          order.push('rights');
          return { info: file, store: 's3' };
        },
      } as unknown as Partial<CoreFileService>,
      [],
    );

    await expect(controller.getFileById('abc', res)).rejects.toMatchObject({ status: 416 });
    expect(order).toEqual(['rights']);
    expect(headers['content-range']).toBe('bytes */100');
  });

  it('answers a refusal with 404, never with 416, whatever the Range says', async () => {
    const { res } = responseStub({ Range: 'bytes=100-' });
    const controller = route({ resolveFile: async () => null } as unknown as Partial<CoreFileService>, []);
    await expect(controller.getFileById('abc', res)).rejects.toMatchObject({ status: 404 });
  });

  it('opens the whole file without a range option when no Range header was sent', async () => {
    const { calls, headers, res } = responseStub();
    const opened: unknown[] = [];
    const controller = route(
      {
        getFileStream: async (...args: unknown[]) => {
          opened.push(args);
          return Readable.from([Buffer.from('x')]);
        },
        resolveFile: async () => ({ info: file, store: 'filesystem' }),
      } as unknown as Partial<CoreFileService>,
      [],
    );
    await controller.getFileById('abc', res);
    expect((opened[0] as [string, Record<string, unknown>])[1]).not.toHaveProperty('range');
    expect(calls.status).toBe(0);
    expect(headers['accept-ranges']).toBe('bytes');
    expect(headers['content-length']).toBe('100');
  });
});

describe('pipeFileToResponse on a 206 that fails before the first byte', () => {
  /**
   * @regression   12.9.3 — a ranged response that fails before its first byte is answered 404 with a JSON body; a
   *   `Content-Range` left on it would describe bytes the body does not contain.
   * @seen-failing Drop 'Content-Range' from FILE_DELIVERY_HEADERS (src/core/modules/file/core-file.controller.ts) —
   *   registered as mutation `range-headers-survive-error` in tests/regression-mutations.json.
   */
  it('drops Content-Range and Accept-Ranges with the other file headers', async () => {
    const { calls, res } = responseStub();
    setDownloadRangeHeaders(res, { end: 1, start: 0 }, 100);
    const stream = new Readable({ read() {} });
    const errors = captureExpectedLogs();
    pipeFileToResponse(stream, res);
    stream.emit('error', new Error('chunks missing'));
    await tick();
    expect(errors.join('\n')).toContain('chunks missing');
    expect(calls.status).toBe(404);
    expect(calls.removed).toEqual(expect.arrayContaining(['Content-Range', 'Accept-Ranges', 'Content-Length']));
  });
});

describe('a ranged response behind compression (real HTTP)', () => {
  /** Serves bytes 10-19 of a 100-byte text file the way the download routes do, behind `compression` */
  async function serve(): Promise<{ port: number; server: Server }> {
    const app = express();
    // The reference `main.ts` passes `compression.filter`, which compresses text/plain — the case that would break
    app.use(compression({ filter: compression.filter, threshold: 0 }));
    const bytes = Buffer.from('0123456789'.repeat(10));
    app.get('/file', (_req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', 'text/plain');
      const range = { end: 19, start: 10 };
      setDownloadRangeHeaders(res, range, bytes.length);
      pipeFileToResponse(Readable.from([bytes.subarray(range.start, range.end + 1)]), res);
    });
    const server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    return { port: (server.address() as AddressInfo).port, server };
  }

  /**
   * @regression   12.9.3 — a `compression` middleware gzips a 206 like any other response, and a compressed range no
   *   longer matches the byte offsets its Content-Range names.
   * @seen-failing Leave `no-transform` out of setDownloadRangeHeaders() (src/core/modules/file/core-file.controller.ts)
   *   — registered as mutation `range-response-compressible` in tests/regression-mutations.json.
   */
  it('keeps the compressor away, so the body is exactly the bytes Content-Range names', async () => {
    const { port, server } = await serve();
    try {
      const answer = await new Promise<{ body: Buffer; headers: Record<string, unknown>; status: number }>(
        (resolve, reject) => {
          const req = httpRequest(
            { agent: false, headers: { 'accept-encoding': 'gzip' }, host: '127.0.0.1', path: '/file', port },
            (res) => {
              const parts: Buffer[] = [];
              res.on('data', (chunk: Buffer) => parts.push(chunk));
              res.on('end', () => resolve({ body: Buffer.concat(parts), headers: res.headers, status: res.statusCode }));
              res.on('error', reject);
            },
          );
          req.on('error', reject);
          req.end();
        },
      );
      expect(answer.status).toBe(206);
      expect(answer.headers['content-encoding']).toBeUndefined();
      expect(answer.headers['content-range']).toBe('bytes 10-19/100');
      expect(answer.body.toString()).toBe('0123456789');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
