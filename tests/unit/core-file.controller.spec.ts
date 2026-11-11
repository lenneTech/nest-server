import { NotFoundException } from '@nestjs/common';
import { EventEmitter } from 'events';
import type { Response } from 'express';
import { createServer, request as httpRequest, validateHeaderValue } from 'http';
import type { AddressInfo } from 'net';
import { PassThrough, Readable } from 'stream';
import { beforeEach, describe, expect, it } from 'vitest';

import { StreamIdleTimeoutError } from '../../src/core/common/helpers/idle-stream.helper';
import type { CoreFileService } from '../../src/core/modules/file/core-file.service';
import { captureExpectedLogs } from '../helpers/expected-log-output';
import {
  buildContentDisposition,
  CoreFileController,
  downloadAbortSignal,
  isResponseGone,
  openDownloadStream,
  pipeFileToResponse,
  RESPONSE_GONE,
} from '../../src/core/modules/file/core-file.controller';

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Build a response stub that records what the handler did to it.
 *
 * A real `Response` is not needed here — what is under test is the decision
 * (status vs. destroy), not Express. Writing it out as a stub also makes the
 * "headers already sent" case reachable, which is awkward to force otherwise.
 *
 * What this stub CANNOT show is how Express itself treats headers: `res.json()`
 * only defaults `Content-Type` when none is set, so a stub whose `json()` merely
 * records a body can never reveal a stale one. That property is pinned at the
 * HTTP level in `tests/file.e2e-spec.ts`; here we assert the removal list.
 */
function responseStub(headersSent = false) {
  const sink = new PassThrough();
  const calls = {
    destroyed: false,
    json: undefined as unknown,
    redirect: undefined as string | undefined,
    removed: [] as string[],
    set: {} as Record<string, string>,
    status: 0,
  };

  const res = Object.assign(sink, {
    destroy: () => {
      calls.destroyed = true;
      return res;
    },
    // Express aliases `header()` to `set()`; the handlers use the former
    header: (name: string, value: string) => {
      calls.set[name] = value;
      return res;
    },
    headersSent,
    json: (body: unknown) => {
      calls.json = body;
      return res;
    },
    redirect: (_status: number, url: string) => {
      calls.redirect = url;
      return res;
    },
    removeHeader: (name: string) => {
      calls.removed.push(name);
    },
    setHeader: (name: string, value: string) => {
      calls.set[name] = value;
      return res;
    },
    status: (code: number) => {
      calls.status = code;
      return res;
    },
  }) as unknown as Response;

  return { calls, res };
}

describe('pipeFileToResponse', () => {
  // The error branches below deliberately drive a failed GridFS read, and the controller
  // reports each one via `logger.error` WITH a stack trace. On a green run that is pure noise
  // — and it is a console write racing vitest's worker teardown. See the helper.
  let expectedErrors: string[];
  beforeEach(() => {
    expectedErrors = captureExpectedLogs();
  });

  it('turns a read error into 404 while nothing has been written yet', async () => {
    // A GridFS record and its bytes are two separate writes, so the record can
    // outlive the chunks. GridFS reports that on the stream, asynchronously.
    // A bare `stream.pipe(res)` installs no error handler, so the error goes
    // unhandled, Node destroys the socket mid-response, and any reverse proxy
    // in front reports 502 Bad Gateway — "the server is down", which is the one
    // diagnosis that is wrong while every other route answers normally.
    const stream = new Readable({ read() {} });
    const { calls, res } = responseStub(false);

    pipeFileToResponse(stream, res);
    stream.emit('error', new Error('FileNotFound: file 0123456789ab was not found'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls.status).toBe(404);
    expect(calls.json).toMatchObject({ statusCode: 404 });
    expect(calls.destroyed).toBe(false);
    // The caller is told 404 on purpose — which makes the SERVER-side log the only place the
    // real cause survives. Capturing it and asserting nothing would discard exactly that.
    expect(expectedErrors.some((line) => line.includes('FileNotFound'))).toBe(true);
  });

  it('drops every header that describes the file, not just the download one', async () => {
    // Each of these would otherwise survive onto the error response:
    // `Content-Disposition` offers a JSON error body as a file to save, a long
    // `Cache-Control` lets the client cache the failure, `ETag` describes bytes
    // that were never sent — and `Content-Type` makes an ofetch/`$fetch` client
    // parse the JSON as an image and lose the message entirely.
    const stream = new Readable({ read() {} });
    const { calls, res } = responseStub(false);

    pipeFileToResponse(stream, res);
    stream.emit('error', new Error('chunks missing'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls.removed).toEqual(
      expect.arrayContaining(['Cache-Control', 'Content-Disposition', 'Content-Type', 'ETag']),
    );
    expect(calls.set['X-Content-Type-Options']).toBe('nosniff');
  });

  it('closes the connection once bytes are already on the wire', async () => {
    // Past the first byte there is no status left to send. Dropping the
    // connection is the only remaining signal — and it is the correct one: it
    // is what a truncated transfer looks like, so the client does not cache a
    // half file as if it were complete.
    const stream = new Readable({ read() {} });
    const { calls, res } = responseStub(true);

    pipeFileToResponse(stream, res);
    stream.emit('error', new Error('connection lost mid-stream'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls.destroyed).toBe(true);
    expect(calls.status).toBe(0);
  });

  it('answers a refused download exactly like an unknown id', async () => {
    // `getFileStream()` returns null when the service's own `checkRights()`
    // refuses — a branch only a CONSUMER project can reach, since the framework's
    // base implementation always returns true. That is precisely why the
    // framework has to pin it: consumers cannot, and if the two answers ever
    // diverge (403 here, 404 there, or different messages) the endpoint becomes
    // an existence oracle for files the caller may not read.
    // Invoked through the prototype rather than a subclass: `CoreFileController`
    // has a protected constructor (it is abstract by design), and a subclass added
    // only to widen that visibility is exactly what `no-useless-constructor`
    // strips — leaving code that no longer compiles.
    // The receiver is `Object.create(prototype)`, not a bare `{ fileService }`:
    // the handler calls sibling methods on `this` (`resolveDownloadUrl`), and an
    // object literal would make those `undefined` — turning this security pin into
    // a TypeError that asserts nothing about the 404-vs-404 answer it exists to check.
    const download = (service: Partial<CoreFileService>, res: Response) =>
      (CoreFileController.prototype.getFileById as (this: unknown, id: string, res: Response) => Promise<unknown>).call(
        Object.create(CoreFileController.prototype, { fileService: { value: service } }),
        'abc',
        res,
      );

    const file = { contentType: 'image/png', filename: 'secret.png', id: 'abc' };
    const { res } = responseStub(false);

    // `resolveFile()` answers metadata AND the store in one lookup, and returns null
    // on a rights refusal exactly as `getFileInfo()` did. Both shapes are pinned here:
    // a file that EXISTS but whose stream is refused, and an id that does not exist.
    const refusedErr = await download(
      {
        getFileStream: async () => null,
        resolveFile: async () => ({ info: file, store: 'gridfs' }),
      } as unknown as Partial<CoreFileService>,
      res,
    ).catch((e: unknown) => e);
    const unknownErr = await download(
      { getFileStream: async () => null, resolveFile: async () => null } as unknown as Partial<CoreFileService>,
      res,
    ).catch((e: unknown) => e);

    expect(refusedErr).toBeInstanceOf(NotFoundException);
    expect(unknownErr).toBeInstanceOf(NotFoundException);
    // Byte-identical answers: same status, same message.
    expect((refusedErr as NotFoundException).getStatus()).toBe((unknownErr as NotFoundException).getStatus());
    expect((refusedErr as NotFoundException).getResponse()).toEqual((unknownErr as NotFoundException).getResponse());
  });

  it('still delivers the file when the presigned URL cannot be produced', async () => {
    // The presigned S3 redirect is an OPTIMIZATION — it moves bytes off the API.
    // So its failure modes (S3 unreachable, `@aws-sdk/s3-request-presigner` not
    // installed, a project service predating the method) must cost nothing: the
    // download falls back to streaming. Letting the rejection escape would turn
    // every download into a 500 the moment S3 hiccups, and a 500 on an id that
    // exists — next to a 404 on one that does not — is also an existence oracle.
    const body = Buffer.from('file bytes');
    const file = { contentType: 'image/png', filename: 'photo.png', id: 'abc' };

    const download = (service: Partial<CoreFileService>, res: Response) =>
      (CoreFileController.prototype.getFileById as (this: unknown, id: string, res: Response) => Promise<unknown>).call(
        Object.create(CoreFileController.prototype, { fileService: { value: service } }),
        'abc',
        res,
      );

    for (const brokenUrlSource of [
      // Throws — S3 outage or missing presigner peer dependency
      {
        getDownloadUrl: async () => {
          throw new Error('S3 unreachable');
        },
      },
      // Absent — a consumer service written before this method existed
      {},
    ]) {
      const stream = Readable.from([body]);
      const { calls, res } = responseStub(false);

      await download(
        {
          getFileStream: async () => stream,
          // `store: 's3'` matters: the presigned branch is only ATTEMPTED for
          // S3-stored bytes now, so a GridFS store here would skip it and the test
          // would pass without ever exercising the failure it exists to cover.
          resolveFile: async () => ({ info: file, store: 's3' }),
          ...brokenUrlSource,
        } as unknown as Partial<CoreFileService>,
        res,
      );

      expect(calls.redirect).toBeUndefined();
      expect(calls.set['Content-Type']).toBe('image/png');
    }
  });

  it('sets the Content-Disposition the shared builder produces', () => {
    // Pins that the route actually goes through the builder — the four cases
    // below assert the rendering, this asserts the wiring, so a future
    // hand-rolled header in setFileHeaders cannot pass unnoticed.
    const { calls, res } = responseStub(false);

    (CoreFileController.prototype as unknown as { setFileHeaders: (r: Response, f: unknown) => void }).setFileHeaders(
      res,
      { contentType: 'application/pdf', filename: 'Übersicht.pdf' },
    );

    expect(calls.set['Content-Disposition']).toBe(buildContentDisposition('Übersicht.pdf'));
  });
});

/**
 * Structure of a well-formed value: exactly one quoted `filename` whose value can
 * contain no `"` at all, followed by exactly one `filename*` ext-value.
 *
 * Matching this IS the injection assertion — a filename that managed to close the
 * quoted-string and append its own parameter could not produce a string of this
 * shape, and neither could one that smuggled a second `filename*` (which would win
 * over `filename` per RFC 6266 §4.3).
 */
const DISPOSITION = /^attachment; filename="([^"]*)"; filename\*=UTF-8''(.*)$/;

/** RFC 8187 `value-chars = *( pct-encoded / attr-char )` */
const EXT_VALUE = /^(?:[A-Za-z0-9!#$&+\-.^_`|~]|%[0-9A-F]{2})*$/;

describe('buildContentDisposition', () => {
  // The `filename` parameter is an RFC 6266 quoted-string and nothing
  // percent-decodes it, so the ASCII fallback has to be literal — percent-encoding
  // it makes a client without `filename*` support save "Jahresbericht%202024.pdf".
  // The `filename*` parameter carries the real name and must be a valid RFC 8187
  // ext-value, which `encodeURIComponent` alone does not produce: it leaves `'`,
  // `(`, `)` and `*`, none of which is an attr-char.
  it.each([
    [
      'leaves a space literal in the quoted name and encodes it in the ext-value',
      'Jahresbericht 2024.pdf',
      'attachment; filename="Jahresbericht 2024.pdf"; filename*=UTF-8\'\'Jahresbericht%202024.pdf',
    ],
    [
      'replaces a non-ASCII character in the quoted name, keeps it in the ext-value',
      'Übersicht.pdf',
      'attachment; filename="_bersicht.pdf"; filename*=UTF-8\'\'%C3%9Cbersicht.pdf',
    ],
    [
      'neutralises CR/LF so setHeader cannot throw ERR_INVALID_CHAR',
      'a\r\nX-Evil: 1.txt',
      'attachment; filename="a__X-Evil: 1.txt"; filename*=UTF-8\'\'a%0D%0AX-Evil%3A%201.txt',
    ],
    [
      "encodes the four non-attr-chars encodeURIComponent leaves ('()*)",
      "O'Brien (final)*.pdf",
      "attachment; filename=\"O'Brien (final)*.pdf\"; filename*=UTF-8''O%27Brien%20%28final%29%2A.pdf",
    ],
  ])('%s', (_name, filename, expected) => {
    expect(buildContentDisposition(filename)).toBe(expected);
  });

  it('emits a header Node accepts and a client cannot re-parameterise', () => {
    for (const filename of [
      'Jahresbericht 2024.pdf',
      'Übersicht.pdf',
      'a\r\nX-Evil: 1.txt',
      "O'Brien (final)*.pdf",
      // The direct attempt: close the quoted-string, append a winning `filename*`.
      "a\"; filename*=UTF-8''evil.exe",
      // A backslash would otherwise start a quoted-pair and escape the closing quote.
      'back\\".exe',
      // Bare `;` — legal inside a quoted-string, and must stay inside it.
      'report; version 2.pdf',
    ]) {
      const value = buildContentDisposition(filename);

      // Would throw ERR_INVALID_CHAR on a surviving CR/LF, which is what turned
      // one hostile filename into a permanent 500 on that file's download.
      expect(() => validateHeaderValue('Content-Disposition', value)).not.toThrow();

      const match = DISPOSITION.exec(value);
      expect(match, `not a single well-formed disposition: ${value}`).not.toBeNull();
      expect(match[2]).toMatch(EXT_VALUE);
      // Nothing that could terminate the header or the parameter survives.
      expect(match[1]).not.toMatch(/["\\\r\n]/);
    }
  });

  it('falls back to a usable name when the file has none', () => {
    // GridFS and both metadata stores allow an empty filename, and an empty
    // `filename=""` makes browsers save the URL's last path segment — which on
    // `/files/id/:id` is the raw ObjectId.
    expect(buildContentDisposition(undefined)).toBe(buildContentDisposition('download'));
    expect(buildContentDisposition('')).toBe(buildContentDisposition('download'));
  });
});

describe('pipeFileToResponse (stream lifecycle)', () => {
  it('destroys the source stream when the client goes away', async () => {
    // `pipe()` only ever unpipes the DESTINATION; it never destroys the source.
    // On a public download route an aborted request would therefore leak the
    // GridFS read stream and its server-side cursor until the cursor timeout.
    const stream = new Readable({ read() {} });
    const { res } = responseStub(false);

    pipeFileToResponse(stream, res);
    expect(stream.destroyed).toBe(false);

    res.emit('close');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stream.destroyed).toBe(true);
  });

  /**
   * @regression   11.46.3 — a client that left BEFORE the stream was handed over (it waited for a free S3 socket)
   *   has a response that already closed; the `close` listener registered then never fired, and the source kept
   *   its socket. Under load: the production avalanche.
   * @seen-failing Drop the early `isResponseGone()` check in pipeFileToResponse()
   *   (src/core/modules/file/core-file.controller.ts) — registered as mutation
   *   `pipe-file-to-response-ignores-closed-response` in tests/regression-mutations.json.
   */
  it('destroys the source at once when the response has already closed', async () => {
    const stream = new Readable({ read() {} });
    const { res } = responseStub(false);
    res.emit('close');
    Object.defineProperty(res, 'closed', { value: true });

    pipeFileToResponse(stream, res);
    await tick();

    expect(stream.destroyed).toBe(true);
  });
});

describe('pipeFileToResponse (idle close)', () => {
  /**
   * @regression   11.46.3 (found in the k6 run against S3) — every download the idle guard closed was logged as an
   *   ERROR with a stack: under an abort storm 20 lines per second, an alert storm for clients that merely stopped
   *   reading. Since then one aggregated warning per minute.
   * @seen-failing Treat an idle close like any other stream error in pipeFileToResponse()
   *   (src/core/modules/file/core-file.controller.ts) — registered as mutation `idle-close-logged-as-error` in
   *   tests/regression-mutations.json.
   */
  it('closes the connection after the first byte without logging an ERROR', async () => {
    const errors = captureExpectedLogs();
    const stream = new Readable({ read() {} });
    const { calls, res } = responseStub(true);

    pipeFileToResponse(stream, res);
    stream.emit('error', new StreamIdleTimeoutError(30_000));
    await tick();

    expect(calls.destroyed).toBe(true);
    expect(errors).toEqual([]);
  });

  it('answers 503 with Retry-After when the store delivered nothing before the idle time', async () => {
    const errors = captureExpectedLogs();
    const stream = new Readable({ read() {} });
    const { calls, res } = responseStub(false);

    pipeFileToResponse(stream, res);
    stream.emit('error', new StreamIdleTimeoutError(30_000));
    await tick();

    expect(calls.status).toBe(503);
    expect(calls.set['Retry-After']).toBe('5');
    expect(errors).toEqual([]);
  });
});

describe('isResponseGone', () => {
  /**
   * @regression   11.46.3 (found in the k6 run against S3) — some aborted downloads reached delivery with the request
   *   and the socket already destroyed while the response still read `destroyed: false, closed: false` and never
   *   emitted `close`; judged by the response alone they were delivered to nobody and held their S3 socket for 30 s.
   * @seen-failing Judge by the response alone in isResponseGone() (src/core/modules/file/core-file.controller.ts) —
   *   registered as mutation `response-gone-ignores-request-state` in tests/regression-mutations.json.
   */
  it('reads a destroyed request or socket as a gone client, even when the response still looks open', async () => {
    const goneRequest = responseStub(true).res;
    Object.defineProperty(goneRequest, 'req', { value: { destroyed: true } });
    const goneSocket = responseStub(true).res;
    Object.defineProperty(goneSocket, 'socket', { value: { destroyed: true } });
    const healthy = responseStub(true).res;
    Object.defineProperty(healthy, 'req', { value: { destroyed: false } });
    Object.defineProperty(healthy, 'socket', { value: { destroyed: false } });

    expect(isResponseGone(goneRequest)).toBe(true);
    expect(isResponseGone(goneSocket)).toBe(true);
    expect(isResponseGone(healthy)).toBe(false);

    // pipeFileToResponse releases the source at once for such a response
    const stream = new Readable({ read() {} });
    pipeFileToResponse(stream, goneRequest);
    await tick();
    expect(stream.destroyed).toBe(true);
  });

  /**
   * @regression   11.46.3 (found in review) — Node destroys a request by itself once its body was read to the end, on a
   *   healthy connection. Read as "client gone", every download answering a request with a body (a POST export, a GET
   *   carrying `Content-Length: 0` that a body parser read) was destroyed before the first byte, and the client waited
   *   for an answer that never came.
   * @seen-failing Count every destroyed request as aborted in isResponseGone()
   *   (src/core/modules/file/core-file.controller.ts) — registered as mutation `response-gone-counts-completed-request`
   *   in tests/regression-mutations.json.
   */
  it('does not read a request destroyed after its body was read to the end as a gone client', () => {
    const completed = responseStub(true).res;
    Object.defineProperty(completed, 'req', { value: { destroyed: true, readableEnded: true } });
    Object.defineProperty(completed, 'socket', { value: { destroyed: false } });
    const aborted = responseStub(true).res;
    Object.defineProperty(aborted, 'req', { value: { destroyed: true, readableEnded: false } });
    Object.defineProperty(aborted, 'socket', { value: { destroyed: false } });

    expect(isResponseGone(completed)).toBe(false);
    expect(isResponseGone(aborted)).toBe(true);
  });
});

describe('downloadAbortSignal', () => {
  /**
   * @regression   11.46.3 (found in review) — the signal aborted on every request close before the response finished,
   *   including Node's own close after a body was read to the end: a project route that passes it to the store had its
   *   S3 request aborted for a client still waiting.
   * @seen-failing Abort on every request close in downloadAbortSignal() (src/core/modules/file/core-file.controller.ts)
   *   — registered as mutation `abort-signal-request-close-after-body-read` in tests/regression-mutations.json.
   */
  it('aborts when the request closes before its end, and not when it closes after its body was read', () => {
    const completed = responseStub(true).res;
    const completedReq = Object.assign(new EventEmitter(), { readableEnded: false });
    Object.defineProperty(completed, 'req', { value: completedReq });
    const quiet = downloadAbortSignal(completed);
    completedReq.readableEnded = true;
    completedReq.emit('close');

    const aborted = responseStub(true).res;
    const abortedReq = Object.assign(new EventEmitter(), { readableEnded: false });
    Object.defineProperty(aborted, 'req', { value: abortedReq });
    const fired = downloadAbortSignal(aborted);
    abortedReq.emit('close');

    expect(quiet.aborted).toBe(false);
    expect(fired.aborted).toBe(true);
  });

  /**
   * @regression   11.46.3 (found in the k6 run with request bodies) — once a body was read, the request's own close no
   *   longer counts, and the signal listened to nothing else but the response. About one in six aborted downloads
   *   never gets a response close (measured under an abort storm), so their S3 requests kept waiting for a socket and
   *   took one later for nobody — the pool peaked higher than without bodies.
   * @seen-failing Do not listen to the socket in downloadAbortSignal() (src/core/modules/file/core-file.controller.ts)
   *   — registered as mutation `download-abort-signal-ignores-socket` in tests/regression-mutations.json.
   */
  it('aborts when the socket reports the client gone after the request body was read', () => {
    for (const event of ['end', 'close'] as const) {
      const { res } = responseStub(true);
      const socket = Object.assign(new EventEmitter(), { destroyed: false });
      Object.defineProperty(res, 'req', { value: Object.assign(new EventEmitter(), { readableEnded: true }) });
      Object.defineProperty(res, 'socket', { value: socket });
      const signal = downloadAbortSignal(res);

      socket.emit(event);
      expect(signal.aborted, event).toBe(true);
    }
  });

  /**
   * @regression   11.46.3 (found in review) — listeners left on a keep-alive socket pile up with every request it
   *   carries, until Node warns about a listener leak.
   * @seen-failing Never remove the socket listeners in downloadAbortSignal()
   *   (src/core/modules/file/core-file.controller.ts) — registered as mutation
   *   `download-abort-signal-leaks-socket-listeners` in tests/regression-mutations.json.
   */
  it('leaves a keep-alive socket without listeners once the response is done', () => {
    const { res } = responseStub(true);
    const socket = Object.assign(new EventEmitter(), { destroyed: false });
    Object.defineProperty(res, 'req', { value: Object.assign(new EventEmitter(), { readableEnded: true }) });
    Object.defineProperty(res, 'socket', { value: socket });
    const signal = downloadAbortSignal(res);

    Object.defineProperty(res, 'writableFinished', { value: true });
    res.emit('finish');
    socket.emit('end');

    expect(signal.aborted).toBe(false);
    expect(socket.listenerCount('end') + socket.listenerCount('close')).toBe(0);
  });
});

describe('download delivery over a real Node HTTP server', () => {
  /** Answers every request after reading its body to the end, the way a body-parsing middleware does */
  async function serve(deliver: (res: Response) => void) {
    const server = createServer((req, res) => {
      req.resume();
      // The request is closed by Node right after its end: deliver once that happened
      req.once('end', () => setImmediate(() => deliver(res as unknown as Response)));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, server };
  }

  function send(port: number, method: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          agent: false,
          headers: { 'content-length': Buffer.byteLength(body), 'content-type': 'application/json' },
          host: '127.0.0.1',
          method,
          path: '/',
          port,
          timeout: 3000,
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on('data', (chunk: Buffer) => parts.push(chunk));
          res.on('end', () => resolve(Buffer.concat(parts).toString()));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('no answer within 3 s')));
      req.on('error', reject);
      req.end(body);
    });
  }

  it('delivers a file and keeps the abort signal quiet when the request body was read to the end', async () => {
    // Whether the signal had fired when delivery began (it fires later, when the finished response closes)
    const abortedAtDelivery: boolean[] = [];
    const { port, server } = await serve((res) => {
      abortedAtDelivery.push(downloadAbortSignal(res).aborted);
      pipeFileToResponse(Readable.from([Buffer.from('file-bytes')]), res);
    });
    try {
      // A POST export with a JSON body, and a GET whose `Content-Length: 0` a body parser reads
      expect(await send(port, 'POST', '{"ids":["a"]}')).toBe('file-bytes');
      expect(await send(port, 'GET', '')).toBe('file-bytes');
      expect(abortedAtDelivery).toEqual([false, false]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('pipeFileToResponse (client-gone signals)', () => {
  /**
   * @regression   11.46.3 (found in the k6 run against S3) — about one in six aborted downloads never got a `close` on
   *   the response although the client had gone; only the request and the socket reported it. Listening on the
   *   response alone left ~790 of 4800 aborted downloads holding an S3 socket for 30 s and filled the pool.
   * @seen-failing Do not listen for the request's close in pipeFileToResponse()
   *   (src/core/modules/file/core-file.controller.ts) — registered as mutation
   *   `pipe-file-to-response-ignores-request-close` in tests/regression-mutations.json.
   */
  it('releases the source when the request or the socket reports the client gone, not only the response', async () => {
    for (const signal of ['request', 'socket-end', 'socket-close'] as const) {
      const { res } = responseStub(true);
      const req = new EventEmitter();
      const socket = Object.assign(new EventEmitter(), { destroyed: false });
      Object.defineProperty(res, 'req', { value: req });
      Object.defineProperty(res, 'socket', { value: socket });
      const stream = new Readable({ read() {} });

      pipeFileToResponse(stream, res);
      if (signal === 'request') {
        req.emit('close');
      } else {
        socket.emit(signal === 'socket-end' ? 'end' : 'close');
      }
      await tick();
      expect(stream.destroyed, signal).toBe(true);
    }
  });

  /**
   * @regression   11.46.3 (found in review) — Node closes a request by itself once its body was read to the end. Read as
   *   "client gone", a download started before that close (a body still streaming in while the file is piped) was
   *   destroyed mid-flight on a healthy connection.
   * @seen-failing Treat every request close as the client leaving in watchClientGone()
   *   (src/core/modules/file/core-file.controller.ts) — registered as mutation `request-close-after-body-read-releases`
   *   in tests/regression-mutations.json.
   */
  it('keeps delivering when the request closes only because its body was read to the end', async () => {
    const { res } = responseStub(true);
    const req = Object.assign(new EventEmitter(), { readableEnded: false });
    Object.defineProperty(res, 'req', { value: req });
    const stream = new Readable({ read() {} });

    pipeFileToResponse(stream, res);
    req.readableEnded = true;
    req.emit('close');
    await tick();

    expect(stream.destroyed).toBe(false);
    stream.destroy();
  });

  it('ignores a request close that follows a finished response, and leaves a keep-alive socket without listeners', async () => {
    const { res } = responseStub(true);
    const req = new EventEmitter();
    const socket = Object.assign(new EventEmitter(), { destroyed: false });
    Object.defineProperty(res, 'req', { value: req });
    Object.defineProperty(res, 'socket', { value: socket });
    const stream = new Readable({ read() {} });

    pipeFileToResponse(stream, res);
    Object.defineProperty(res, 'writableFinished', { value: true });
    res.emit('finish');
    req.emit('close');
    await tick();

    expect(stream.destroyed).toBe(false);
    expect(socket.listenerCount('end') + socket.listenerCount('close')).toBe(0);
    stream.destroy();
  });
});

describe('openDownloadStream (a project\'s own download route)', () => {
  /**
   * @regression   11.46.4 (found in a consumer project) — the documented pattern for an own route passed
   *   `downloadAbortSignal(res)` to `getFileStream()`. When the client left before S3 answered, the aborted request
   *   rejected with `AbortError`, nothing caught it, and every aborted download became an ERROR with a stack trace
   *   plus a 500 sent into a closed response — under the load the pool-exhausted log line has to stand out in.
   * @seen-failing Rethrow a store error although the client has gone in openDownloadStream()
   *   (src/core/modules/file/core-file.controller.ts) — registered as mutation `open-download-abort-rethrown` in
   *   tests/regression-mutations.json.
   */
  it('answers RESPONSE_GONE, without an error, when the store request is aborted because the client left', async () => {
    const { res } = responseStub(false);
    const signal = downloadAbortSignal(res);
    // What the S3 SDK does with an aborted request: it rejects with AbortError
    const pending = openDownloadStream(
      res,
      () =>
        new Promise<Readable>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })),
          );
        }),
    );
    Object.defineProperty(res, 'closed', { value: true });
    res.emit('close');

    await expect(pending).resolves.toBe(RESPONSE_GONE);
  });

  it('does not ask the store when the client has already gone', async () => {
    const { res } = responseStub(false);
    Object.defineProperty(res, 'destroyed', { value: true });
    let asked = false;

    const answer = await openDownloadStream(res, async () => {
      asked = true;
      return new Readable({ read() {} });
    });

    expect(answer).toBe(RESPONSE_GONE);
    expect(asked).toBe(false);
  });

  /**
   * @regression   11.46.4 — an own route had no way to the 503 the framework's routes answer when the store hands out
   *   no connection in time; `TimeoutError` reached Nest as a 500.
   * @seen-failing Treat TimeoutError like any other error in openDownloadStream()
   *   (src/core/modules/file/core-file.controller.ts) — registered as mutation `open-download-timeout-not-503` in
   *   tests/regression-mutations.json.
   */
  it('answers 503 with Retry-After when the store hands out no connection in time, and rethrows other errors', async () => {
    const { calls, res } = responseStub(false);
    const errors = captureExpectedLogs();
    const timeout = openDownloadStream(res, async () => {
      throw Object.assign(new Error('did not establish a connection within 15000 ms'), { name: 'TimeoutError' });
    });
    await expect(timeout).rejects.toMatchObject({ status: 503 });
    expect(calls.set['Retry-After']).toBe('5');

    const broken = new Error('missing chunks');
    await expect(
      openDownloadStream(responseStub(false).res, async () => {
        throw broken;
      }),
    ).rejects.toBe(broken);
    expect(errors).toEqual([]);
  });

  it('passes a refusal (null) on unchanged and hands out a stream while the client waits', async () => {
    const { res } = responseStub(false);
    const stream = new Readable({ read() {} });

    expect(await openDownloadStream(res, async () => null)).toBeNull();
    expect(await openDownloadStream(res, async () => stream)).toBe(stream);
    stream.destroy();
  });
});

describe('download routes (client gone)', () => {
  const file = { contentType: 'image/png', filename: 'a.png', id: 'abc', length: 3 };

  function route(service: Partial<CoreFileService>, piped: Readable[]) {
    return Object.create(CoreFileController.prototype, {
      fileService: { value: service },
      pipeFileToResponse: { value: (stream: Readable, res: Response) => (piped.push(stream), res) },
    }) as CoreFileController;
  }

  /**
   * @regression   11.46.3 — a stream that arrived after the client had gone was handed on as if somebody were
   *   still waiting for it; with a project's own delivery code that is a source nobody reads or destroys.
   * @seen-failing Hand a late stream on in openDownloadStream() (src/core/modules/file/core-file.controller.ts) —
   *   registered as mutation `download-route-keeps-late-stream` in tests/regression-mutations.json.
   */
  it('destroys a stream that arrives after the client left, and delivers nothing', async () => {
    const { res } = responseStub(false);
    const late = new Readable({ read() {} });
    const piped: Readable[] = [];
    let signal: AbortSignal | undefined;
    const controller = route(
      {
        getFileStream: async (_id: string, options?: { abortSignal?: AbortSignal }) => {
          signal = options?.abortSignal;
          // The client leaves while the store request is pending
          res.emit('close');
          Object.defineProperty(res, 'closed', { value: true });
          return late;
        },
        resolveFile: async () => ({ info: file, store: 's3' }),
      } as unknown as Partial<CoreFileService>,
      piped,
    );

    await controller.getFileById('abc', res);

    expect(piped).toEqual([]);
    expect(late.destroyed).toBe(true);
    // The store request was told: an S3 request still waiting for a socket is dropped
    expect(signal?.aborted).toBe(true);
  });

  it('answers 503 with Retry-After when the store hands out no connection in time', async () => {
    const { calls, res } = responseStub(false);
    const controller = route(
      {
        getFileStream: async () => {
          throw Object.assign(new Error('did not establish a connection within 30000 ms'), { name: 'TimeoutError' });
        },
        resolveFile: async () => ({ info: file, store: 's3' }),
      } as unknown as Partial<CoreFileService>,
      [],
    );
    const error = await controller.getFileById('abc', res).catch((e: unknown) => e);
    expect((error as { getStatus?: () => number }).getStatus?.()).toBe(503);
    expect(calls.set['Retry-After']).toBe('5');
  });

  it('does not ask the store at all when the client left during the rights check', async () => {
    const { res } = responseStub(false);
    let opened = false;
    const controller = route(
      {
        getFileStream: async () => {
          opened = true;
          return new Readable({ read() {} });
        },
        resolveFile: async () => {
          res.emit('close');
          Object.defineProperty(res, 'closed', { value: true });
          return { info: file, store: 's3' };
        },
      } as unknown as Partial<CoreFileService>,
      [],
    );

    await controller.getFileById('abc', res);
    expect(opened).toBe(false);
  });

  it('answers 304 to a matching If-None-Match only after the rights check, without opening the store', async () => {
    const { calls, res } = responseStub(false);
    let ended = false;
    Object.assign(res, {
      end: () => {
        ended = true;
        return res;
      },
      req: { headers: { 'if-none-match': '"abc"' } },
      status: (code: number) => {
        calls.status = code;
        return res;
      },
    });
    let opened = false;
    const order: string[] = [];
    const controller = route(
      {
        getFileStream: async () => {
          opened = true;
          return new Readable({ read() {} });
        },
        resolveFile: async () => {
          order.push('rights');
          return { info: file, store: 's3' };
        },
      } as unknown as Partial<CoreFileService>,
      [],
    );

    await controller.getFileById('abc', res);
    expect(order).toEqual(['rights']);
    expect(calls.status).toBe(304);
    expect(ended).toBe(true);
    expect(opened).toBe(false);
    expect(calls.set.ETag).toBe('W/"abc"');
  });

  it('sends ETag and Content-Length with a delivered file, and keeps no-store by default', async () => {
    const { calls, res } = responseStub(false);
    const piped: Readable[] = [];
    const controller = route(
      {
        getFileStream: async () => Readable.from([Buffer.from('abc')]),
        resolveFile: async () => ({ info: file, store: 'gridfs' }),
      } as unknown as Partial<CoreFileService>,
      piped,
    );

    await controller.getFileById('abc', res);
    expect(piped).toHaveLength(1);
    expect(calls.set.ETag).toBe('W/"abc"');
    expect(calls.set['Content-Length']).toBe('3');
    expect(calls.set['Cache-Control']).toBe('private, no-store');
  });
});
