/**
 * How an upload reaches S3 — streamed in one request, streamed in parts, and only as a last resort
 * read into memory.
 *
 * Until this change every upload through `CoreFileService.createFile()` under the S3 driver was read
 * into a Buffer first, and so was every stream `CoreS3Service.putObject()` received without a
 * length. The memory cost of an upload therefore equalled its size: a multi-GB file threw "Array
 * buffer allocation failed" or got the container OOM-killed at 100 % progress, taking every other
 * in-flight request with it. Now:
 *
 *   length known    → one streamed PutObject (`Content-Length` set, nothing buffered) — up to 5 GiB,
 *                     above that a multipart upload, since AWS S3 refuses larger single requests
 *   length unknown  → a multipart upload via the optional peer `@aws-sdk/lib-storage`
 *   peer missing    → buffered, as before — reported once, so the cost is not silent
 *
 * Both streamed paths are equals, not one an optimisation of the other: a GraphQL or streamed REST
 * upload NEVER knows its length (a multipart request's `Content-Length` counts the whole envelope),
 * so "unknown" is the common case. These tests pin the ROUTING with fakes; whether the bytes then
 * arrive intact is the parity matrix's job (`service.unknownLengthStreamRoundTrip` and
 * `service.knownSizeStreamRoundTrip`, against a real S3-compatible store), and a failing source on
 * the multipart path is covered in `tests/file-upload-stream-error.e2e-spec.ts`.
 */
import { Logger } from '@nestjs/common';
import { Readable } from 'node:stream';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { IServerOptions } from '../../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreS3Service } from '../../src/core/common/services/core-s3.service';
import { CoreFileService } from '../../src/core/modules/file/core-file.service';
import { isKnownUploadSize, S3FileHelper } from '../../src/core/modules/file/s3-file.helper';

// ---------------------------------------------------------------------------------------------
// Fakes — the SDK, the client and the multipart uploader, recording what they were handed
// ---------------------------------------------------------------------------------------------

class PutObjectCommand {
  constructor(readonly input: Record<string, any>) {}
}
class HeadObjectCommand {
  constructor(readonly input: Record<string, any>) {}
}

async function drain(body: unknown): Promise<number> {
  if (Buffer.isBuffer(body)) {
    return body.length;
  }
  let bytes = 0;
  for await (const chunk of body as Readable) {
    bytes += Buffer.from(chunk).length;
  }
  return bytes;
}

/** A recording stand-in for `@aws-sdk/lib-storage`'s `Upload`. */
function fakeUploaderModule() {
  const uploads: { bytes: number; params: Record<string, any> }[] = [];
  const module = {
    Upload: class {
      constructor(readonly options: { client: unknown; params: Record<string, any> }) {}

      async done() {
        uploads.push({ bytes: await drain(this.options.params.Body), params: this.options.params });
      }
    },
  };
  return { module, uploads };
}

class TestS3Service extends CoreS3Service {
  collectCalls = 0;
  readonly sent: (HeadObjectCommand | PutObjectCommand)[] = [];

  /** Puts the service into its initialized state without a network — and with the given uploader. */
  install(uploader: unknown): this {
    this.sdk = { HeadObjectCommand, PutObjectCommand } as any;
    this.client = {
      send: async (command: HeadObjectCommand | PutObjectCommand) => {
        this.sent.push(command);
        if (command instanceof PutObjectCommand) {
          await drain(command.input.Body);
        }
        return {};
      },
    } as any;
    this.multipartUploader = uploader as any;
    return this;
  }

  protected override async collect(stream: Readable): Promise<Buffer> {
    this.collectCalls++;
    return super.collect(stream);
  }

  get puts(): PutObjectCommand[] {
    return this.sent.filter((command): command is PutObjectCommand => command instanceof PutObjectCommand);
  }

  /** Exposed so the import path itself can be asserted. */
  load() {
    return this.loadMultipartUploader();
  }
}

function s3Service(): TestS3Service {
  ConfigService.setConfig({ env: 'test', s3: { bucket: 'uploads' } } as unknown as IServerOptions, { reInit: true });
  return new TestS3Service(new ConfigService(ConfigService.configFastButReadOnly as any, { warn: false }));
}

const threeChunks = () => Readable.from([Buffer.from('alpha-'), Buffer.from('beta-'), Buffer.from('gamma')]);

afterAll(() => {
  ConfigService.setConfig({ env: 'test' } as unknown as IServerOptions, { reInit: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@aws-sdk/lib-storage');
});

// ---------------------------------------------------------------------------------------------

describe('CoreS3Service.putObject — how a body reaches S3', () => {
  it('hands a stream of unknown length to the multipart uploader as it is — never into memory', async () => {
    const { module, uploads } = fakeUploaderModule();
    const service = s3Service().install(module);
    const stream = threeChunks();

    await service.putObject('object-key', stream, 'text/plain');

    expect(uploads).toHaveLength(1);
    // Identity, not equality: the uploader must receive the SOURCE stream, not a buffered copy of it.
    expect(uploads[0].params.Body).toBe(stream);
    expect(uploads[0].params).toMatchObject({ Bucket: 'uploads', ContentType: 'text/plain', Key: 'object-key' });
    expect(uploads[0].bytes).toBe(16);
    expect(service.collectCalls, 'the stream must not have been read into memory').toBe(0);
    expect(service.puts, 'no single-request PutObject alongside the multipart upload').toHaveLength(0);
  });

  it('streams a body of KNOWN length as one PutObject, without the uploader and without buffering', async () => {
    const { module, uploads } = fakeUploaderModule();
    const service = s3Service().install(module);

    await service.putObject('object-key', threeChunks(), 'text/plain', 16);

    expect(uploads).toHaveLength(0);
    expect(service.collectCalls).toBe(0);
    expect(service.puts).toHaveLength(1);
    expect(service.puts[0].input).toMatchObject({ Bucket: 'uploads', ContentLength: 16, Key: 'object-key' });
    expect(Buffer.isBuffer(service.puts[0].input.Body), 'a known length is streamed, not buffered').toBe(false);
  });

  it('sends a KNOWN length above the single-request limit as a multipart upload, with that length', async () => {
    // AWS S3 refuses a single PutObject above 5 GiB (`EntityTooLarge`) — for a finished TUS upload
    // that is after the client sent every byte, and every retry fails the same way. The test store
    // (RustFS) accepts it, which is why only the routing can pin this.
    const { module, uploads } = fakeUploaderModule();
    const service = s3Service().install(module);
    const stream = threeChunks();
    const aboveLimit = CoreS3Service.MAX_SINGLE_PUT_BYTES + 1;

    await service.putObject('object-key', stream, 'text/plain', aboveLimit);

    expect(uploads).toHaveLength(1);
    expect(uploads[0].params.Body).toBe(stream);
    // The total is what lets `Upload` size its parts within the 10 000-part limit.
    expect(uploads[0].params.ContentLength).toBe(aboveLimit);
    expect(service.puts).toHaveLength(0);
    expect(service.collectCalls).toBe(0);
  });

  it('paired control: without the optional peer a known length above the limit stays ONE PutObject, as before', async () => {
    // MinIO and RustFS accept such a request; failing it here would break a deployment that works.
    const service = s3Service().install(null);
    const aboveLimit = CoreS3Service.MAX_SINGLE_PUT_BYTES + 1;

    await service.putObject('object-key', threeChunks(), 'text/plain', aboveLimit);

    expect(service.puts).toHaveLength(1);
    expect(service.puts[0].input.ContentLength).toBe(aboveLimit);
    expect(service.collectCalls).toBe(0);
  });

  it('paired control: buffers an unknown-length stream only when the optional peer is missing', async () => {
    // Proves the first case is decided by the uploader, not by a putObject that never buffers at
    // all — and that a project without the peer keeps a working (if memory-hungry) upload.
    const service = s3Service().install(null);

    await service.putObject('object-key', threeChunks(), 'text/plain');

    expect(service.collectCalls).toBe(1);
    expect(service.puts).toHaveLength(1);
    expect(service.puts[0].input.ContentLength).toBe(16);
    expect(Buffer.isBuffer(service.puts[0].input.Body)).toBe(true);
  });
});

describe('CoreS3Service — the optional peer @aws-sdk/lib-storage', () => {
  it('resolves the installed package, once', async () => {
    const service = s3Service().install(undefined);

    const first = await service.load();
    const second = await service.load();

    expect(typeof first?.Upload).toBe('function');
    expect(second).toBe(first);
  });

  it('reports a missing package ONCE, and does not retry the import on every upload', async () => {
    vi.doMock('@aws-sdk/lib-storage', () => {
      throw new Error("Cannot find module '@aws-sdk/lib-storage'");
    });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = s3Service().install(undefined);

    expect(await service.load()).toBeUndefined();
    expect(await service.load()).toBeUndefined();
    await service.putObject('object-key', threeChunks(), 'text/plain');

    const reports = warn.mock.calls.filter(([message]) => String(message).includes('@aws-sdk/lib-storage'));
    expect(reports).toHaveLength(1);
    expect(String(reports[0][0])).toContain('pnpm add @aws-sdk/lib-storage');
    // …and the upload still went through, buffered.
    expect(service.collectCalls).toBe(1);
    expect(service.puts).toHaveLength(1);
  });
});

describe('S3FileHelper.writeFile — which length S3 is given', () => {
  it.each([
    [undefined, false],
    [0, false],
    [-1, false],
    [Number.NaN, false],
    [1.5, false],
    ['12', false],
    [Number.MAX_SAFE_INTEGER + 2, false],
    [1, true],
    [12_582_912, true],
  ])('isKnownUploadSize(%s) → %s', (size, known) => {
    // A WRONG length breaks an upload; an unknown one only costs multipart round trips. So everything that is not unambiguously a length counts as unknown.
    expect(isKnownUploadSize(size)).toBe(known);
  });

  function fakeStore(storedLength: number) {
    const putObject = vi.fn(async (_key: string, body: unknown, _contentType?: string, _contentLength?: number) => {
      await drain(body);
    });
    const statObject = vi.fn(async () => ({ contentLength: storedLength }));
    const insertOne = vi.fn(async () => ({}));
    return {
      collection: { createIndex: vi.fn(async () => 'filename_1'), insertOne } as any,
      insertOne,
      putObject,
      s3: { putObject, statObject } as unknown as CoreS3Service,
    };
  }

  it('passes an exact size through as the Content-Length, and records it', async () => {
    const store = fakeStore(999);
    const body = threeChunks();

    const info = await S3FileHelper.writeFile(store.s3, store.collection, { body, contentLength: 16, filename: 'a.txt' });

    expect(store.putObject.mock.calls[0][1]).toBe(body);
    expect(store.putObject.mock.calls[0][3]).toBe(16);
    expect(info.length).toBe(16);
  });

  it('passes NO length for an unusable size, and records what S3 actually stored', async () => {
    const store = fakeStore(16);
    const body = threeChunks();

    const info = await S3FileHelper.writeFile(store.s3, store.collection, {
      body,
      contentLength: Number.NaN,
      filename: 'b.txt',
    });

    expect(store.putObject.mock.calls[0][1]).toBe(body);
    expect(store.putObject.mock.calls[0][3]).toBeUndefined();
    // The stored object is the authority on its size — not a guess made before the upload.
    expect(info.length).toBe(16);
  });
});

describe('CoreFileService.createFile — the S3 branch hands over the stream', () => {
  class TestFileService extends CoreFileService {
    constructor(s3: CoreS3Service) {
      super({ db: { collection: () => ({}) } } as any, 'fs', { s3Service: s3 });
    }
  }

  function setUp() {
    ConfigService.setConfig(
      { env: 'test', file: { storage: 's3' }, s3: { bucket: 'uploads' } } as unknown as IServerOptions,
      { reInit: true },
    );
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const writeFile = vi
      .spyOn(S3FileHelper, 'writeFile')
      .mockImplementation(async (_s3, _collection, options) => ({ _id: 'id', filename: options.filename }) as any);
    const service = new TestFileService({ enabled: true } as unknown as CoreS3Service);
    return { service, writeFile };
  }

  it('without a size: the stream itself and no length — never a buffer', async () => {
    const { service, writeFile } = setUp();
    const stream = threeChunks();

    await service.createFile({ createReadStream: () => stream, filename: 'c.txt', mimetype: 'text/plain' });

    const options = writeFile.mock.calls[0][2];
    expect(options.body).toBe(stream);
    expect(options.buffer).toBeUndefined();
    expect(options.contentLength).toBeUndefined();
  });

  it('with a size: the stream itself plus that length', async () => {
    const { service, writeFile } = setUp();
    const stream = threeChunks();

    await service.createFile({ createReadStream: () => stream, filename: 'd.txt', mimetype: 'text/plain', size: 16 });

    const options = writeFile.mock.calls[0][2];
    expect(options.body).toBe(stream);
    expect(options.contentLength).toBe(16);
  });
});
