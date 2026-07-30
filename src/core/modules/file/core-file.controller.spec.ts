import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { PassThrough, Readable } from 'stream';
import { describe, expect, it } from 'vitest';

import type { CoreFileService } from './core-file.service';
import { CoreFileController, pipeFileToResponse } from './core-file.controller';

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
    removed: [] as string[],
    set: {} as Record<string, string>,
    status: 0,
  };

  const res = Object.assign(sink, {
    destroy: () => {
      calls.destroyed = true;
      return res;
    },
    headersSent,
    json: (body: unknown) => {
      calls.json = body;
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
    const download = (service: Partial<CoreFileService>, res: Response) =>
      (CoreFileController.prototype.getFileById as (this: unknown, id: string, res: Response) => Promise<unknown>).call(
        { fileService: service },
        'abc',
        res,
      );

    const file = { contentType: 'image/png', filename: 'secret.png', id: 'abc' };
    const { res } = responseStub(false);

    const refusedErr = await download(
      { getFileInfo: async () => file, getFileStream: async () => null } as unknown as Partial<CoreFileService>,
      res,
    ).catch((e: unknown) => e);
    const unknownErr = await download(
      { getFileInfo: async () => null, getFileStream: async () => null } as unknown as Partial<CoreFileService>,
      res,
    ).catch((e: unknown) => e);

    expect(refusedErr).toBeInstanceOf(NotFoundException);
    expect(unknownErr).toBeInstanceOf(NotFoundException);
    // Byte-identical answers: same status, same message.
    expect((refusedErr as NotFoundException).getStatus()).toBe((unknownErr as NotFoundException).getStatus());
    expect((refusedErr as NotFoundException).getResponse()).toEqual((unknownErr as NotFoundException).getResponse());
  });

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
