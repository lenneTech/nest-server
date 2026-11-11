/**
 * The per-call opt-out of the download idle guard reaches every store.
 *
 * Since 11.46.3 every download stream closes itself after `downloadIdleTimeoutMs` without read progress. Code that
 * reads streams LATE on purpose (a ZIP export that appends every file first) is told to pass
 * `downloadIdleTimeoutMs: false` — for S3 that option has to travel through four hops (`FileServiceOptions` →
 * `s3StreamOptions()` → `S3FileHelper.getStream()` → `CoreS3Service.getObject()`) and be honoured by two guards.
 * Losing it on any hop leaves exactly the projects that followed the documented fix with hanging exports.
 *
 * Runs the real `CoreFileService` and `CoreS3Service` code with the S3 client and the rights check stubbed.
 */
import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';

import { isIdleGuardedStream } from '../../src/core/common/helpers/idle-stream.helper';
import { CoreS3Service } from '../../src/core/common/services/core-s3.service';
import { CoreFileService } from '../../src/core/modules/file/core-file.service';

import type { ConfigService } from '../../src/core/common/services/config.service';

const FILE_ID = '0123456789abcdef01234567';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A real CoreS3Service whose SDK client answers every GetObject with a fresh, unread body */
function s3ServiceWithBodies() {
  const configService = {
    getFastButReadOnly: (key: string, fallback?: unknown) =>
      key === 's3' ? { bucket: 'files', downloadIdleTimeoutMs: 80 } : fallback,
  } as unknown as ConfigService;
  const service = new CoreS3Service(configService);
  const bodies: Readable[] = [];
  Object.assign(service, {
    client: {
      send: async () => {
        const body = new Readable({
          read() {
            setImmediate(() => this.push(Buffer.alloc(16 * 1024)));
          },
        });
        bodies.push(body);
        return { Body: body, ContentLength: 3 };
      },
    },
    sdk: {
      GetObjectCommand: class {
        constructor(readonly input: unknown) {}
      },
    },
  });
  return { bodies, service };
}

/** A real CoreFileService on top of it, with the rights check granted */
function fileService(s3Service: CoreS3Service): CoreFileService {
  return Object.create(CoreFileService.prototype, {
    checkRights: { value: async () => true },
    options: { value: { s3Service } },
  }) as CoreFileService;
}

describe('per-call opt-out of the download idle guard', () => {
  /**
   * @regression   11.46.3 (found in review) — the documented opt-out for late readers must reach the S3 body: losing
   *   it on one of the four hops leaves S3 streams guarded while filesystem and GridFS honour it, and a ZIP export
   *   that followed the migration guide hangs anyway.
   * @seen-failing Drop `idleTimeoutMs` from s3StreamOptions() (src/core/modules/file/core-file.service.ts) —
   *   registered as mutation `file-stream-drops-idle-opt-out` in tests/regression-mutations.json.
   */
  it('never idle-closes the S3 body of a caller that opts out with downloadIdleTimeoutMs: false', async () => {
    const { bodies, service } = s3ServiceWithBodies();
    const stream = await fileService(service).getFileStream(FILE_ID, { downloadIdleTimeoutMs: false }, 's3');

    // Far beyond the configured 80 ms: the opt-out reached the S3 body
    await sleep(300);
    expect(bodies[0].destroyed).toBe(false);
    stream.destroy();
    await sleep(10);
    expect(bodies[0].destroyed).toBe(true);
  });

  /**
   * @regression   11.46.3 (found in review) — the opt-out first handed back the RAW S3 body. The SDK's socket timeout
   *   destroys an unread body WITH an error, and a checksum-wrapped body re-emits it on a stream nobody listens to:
   *   an uncaught exception that ends the API process. The opt-out now keeps the guard (error handling, release on
   *   close) and only skips its timer.
   * @seen-failing Hand back the raw body for `idleTimeoutMs: false` in CoreS3Service.getObject()
   *   (src/core/common/services/core-s3.service.ts) — registered as mutation `s3-opt-out-returns-raw-body` in
   *   tests/regression-mutations.json.
   */
  it('keeps an error listener on an opted-out S3 body, so a socket timeout cannot end the process', async () => {
    const { bodies, service } = s3ServiceWithBodies();
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      const { body } = await service.getObject('key', { idleTimeoutMs: false });
      // What the SDK's socket timeout does to an unread body
      bodies[0].destroy(Object.assign(new Error('socket timed out'), { name: 'TimeoutError' }));
      await sleep(20);
      expect(uncaught).toEqual([]);
      expect(body.destroyed).toBe(true);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('applies a per-call idle time to the S3 body', async () => {
    const { bodies, service } = s3ServiceWithBodies();
    const stream = await fileService(service).getFileStream(FILE_ID, { downloadIdleTimeoutMs: 50 }, 's3');

    expect(isIdleGuardedStream(stream)).toBe(true);
    await sleep(200);
    expect(bodies[0].destroyed).toBe(true);
  });

  it('guards the S3 body with the configured idle time when the caller says nothing', async () => {
    const { bodies, service } = s3ServiceWithBodies();
    const stream = await fileService(service).getFileStream(FILE_ID, {}, 's3');

    expect(isIdleGuardedStream(stream)).toBe(true);
    await sleep(300);
    expect(bodies[0].destroyed).toBe(true);
  });

  it('honours the opt-out for filesystem and GridFS streams as well', async () => {
    const { service } = s3ServiceWithBodies();
    const files = fileService(service) as unknown as {
      guardDownloadStream: (stream: Readable, options?: { downloadIdleTimeoutMs?: false | number }) => Readable;
    };
    const kept = new Readable({ read() {} });
    const optedOut = files.guardDownloadStream(kept, { downloadIdleTimeoutMs: false });
    const closed = new Readable({ read() {} });
    files.guardDownloadStream(closed, { downloadIdleTimeoutMs: 50 });

    await sleep(200);
    expect(kept.destroyed).toBe(false);
    expect(closed.destroyed).toBe(true);
    optedOut.destroy();
  });

  it('lets CoreS3Service.getObject() callers opt out or set their own idle time', async () => {
    const { bodies, service } = s3ServiceWithBodies();

    const kept = await service.getObject('key', { idleTimeoutMs: false });
    const short = await service.getObject('key', { idleTimeoutMs: 50 });

    await sleep(200);
    expect(bodies[0].destroyed).toBe(false);
    expect(bodies[1].destroyed).toBe(true);
    kept.body.destroy();
  });
});
