import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { validateHeaderValue } from 'http';
import { PassThrough, Readable } from 'stream';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CoreFileService } from '../../src/core/modules/file/core-file.service';
import { captureExpectedLogs } from '../helpers/expected-log-output';
import {
  buildContentDisposition,
  CoreFileController,
  pipeFileToResponse,
} from '../../src/core/modules/file/core-file.controller';

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
});
