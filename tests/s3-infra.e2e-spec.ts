import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreS3Service } from '../src/core/common/services/core-s3.service';
import { dropS3Buckets } from './helpers/s3-test-cleanup';

import type { ConfigService } from '../src/core/common/services/config.service';

/**
 * Round-trip tests against a REAL S3-compatible store (RustFS).
 * Locally: dedicated container on localhost:9102; in CI: the ci-rustfs service.
 * Isolation: unique bucket per run, removed afterwards.
 */
const RUN_BUCKET = `nest-server-e2e-${Date.now()}-p${process.pid}`;

// The image tag must stay identical to the pin in scripts/test-infra.mjs and
// .github/actions/test-infra/action.yml. A hint that says `:latest` starts a
// container `containerMatches()` rejects, so the next `pnpm test` tears it down
// and recreates it — for a developer who followed the instructions.
const START_CONTAINER
  = 'docker run -d --name nest-server-2985-rustfs -p 9102:9000 -e RUSTFS_ROOT_USER=rustfs '
    + '-e RUSTFS_ROOT_PASSWORD=rustfs-secret -e RUSTFS_VOLUMES=/data rustfs/rustfs:1.0.0-rc.1 server /data';

function createService(): CoreS3Service {
  const s3Config = {
    accessKeyId: process.env.S3_ACCESS_KEY || 'rustfs',
    bucket: RUN_BUCKET,
    endpoint: process.env.S3_ENDPOINT || 'http://localhost:9102',
    forcePathStyle: true,
    presignedDownloads: true,
    region: 'us-east-1',
    secretAccessKey: process.env.S3_SECRET_KEY || 'rustfs-secret',
  };
  const configService = {
    getFastButReadOnly: (key: string, defaultValue?: unknown) => (key === 's3' ? s3Config : defaultValue),
  } as unknown as ConfigService;
  return new CoreS3Service(configService);
}

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

describe('S3 infrastructure (real RustFS)', () => {
  let service: CoreS3Service;

  beforeAll(async () => {
    service = createService();
    await service.onModuleInit();
    try {
      await service.ensureBucket(RUN_BUCKET);
    } catch (error) {
      // A refused connection arrives as an AggregateError with an EMPTY message —
      // the only readable part is `code`.
      const reason
        = error instanceof Error ? error.message || (error as { code?: string }).code || error.name : String(error);
      throw new Error(
        `No S3-compatible store reachable on ${process.env.S3_ENDPOINT || 'http://localhost:9102'} `
        + `(${reason}). Start the test container:\n  ${START_CONTAINER}`, { cause: error },
      );
    }
  });

  afterAll(async () => {
    // Both buckets this suite can create: the run bucket and the one the
    // autoCreateBucket case makes. Missing the second leaked one empty bucket
    // per run into the shared store.
    await dropS3Buckets(service.getClient(), [RUN_BUCKET, `${RUN_BUCKET}-auto`]);
    await service.onApplicationShutdown();
  });

  it('uploads, checks, downloads and deletes an object', async () => {
    await service.putObject('smoke/hello.txt', 'hello s3', 'text/plain');
    expect(await service.objectExists('smoke/hello.txt')).toBe(true);

    const download = await service.getObject('smoke/hello.txt');
    expect(await streamToString(download.body)).toBe('hello s3');
    expect(download.contentType).toBe('text/plain');

    await service.deleteObject('smoke/hello.txt');
    expect(await service.objectExists('smoke/hello.txt')).toBe(false);
  });

  it('uploads from a stream', async () => {
    await service.putObject('smoke/stream.txt', Readable.from(['chunk1', 'chunk2']), 'text/plain');
    const download = await service.getObject('smoke/stream.txt');
    expect(await streamToString(download.body)).toBe('chunk1chunk2');
    await service.deleteObject('smoke/stream.txt');
  });

  it('creates a presigned download URL that actually works', async () => {
    await service.putObject('smoke/presigned.txt', 'presigned content', 'text/plain');
    const url = await service.getPresignedDownloadUrl('smoke/presigned.txt', 'download.txt');
    if (!url) {
      throw new Error('Expected a presigned URL');
    }

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('presigned content');
    expect(response.headers.get('content-disposition')).toContain('download.txt');

    await service.deleteObject('smoke/presigned.txt');
  });

  it('reports a missing bucket at boot instead of letting the first upload 500', async () => {
    // Found by running the real thing on a two-replica swarm: with `s3` configured but the
    // bucket absent, nothing complained at startup and every upload came back as a bare
    // `500 Internal Server Error`, with `NoSuchBucket` visible only in the server log — a
    // configuration mistake reported as a server fault, at the worst possible moment.
    const missing = `${RUN_BUCKET}-does-not-exist`;
    const probe = createService();
    (probe as any).config = { ...(probe as any).config, bucket: missing, stagingBucket: missing };

    const errors: string[] = [];
    (probe as any).logger = { error: (msg: string) => errors.push(msg), log: () => undefined };

    await probe.onModuleInit();

    expect(errors.join('\n')).toContain(missing);
    expect(errors.join('\n')).toMatch(/autoCreateBucket/);
    await probe.onApplicationShutdown();
  });

  it('creates the bucket at boot when autoCreateBucket is on', async () => {
    const created = `${RUN_BUCKET}-auto`;
    const creator = createService();
    (creator as any).config = {
      ...(creator as any).config,
      autoCreateBucket: true,
      bucket: created,
      stagingBucket: created,
    };

    await creator.onModuleInit();

    // Provable by using it: a put/get round-trip only works against a bucket that exists
    await creator.putObject('auto/created.txt', 'auto', 'text/plain');
    expect(await creator.objectExists('auto/created.txt')).toBe(true);

    await creator.deleteObject('auto/created.txt');
    await creator.onApplicationShutdown();
  });

  it('is inert without config', async () => {
    const disabled = new CoreS3Service({
      getFastButReadOnly: () => undefined,
    } as unknown as ConfigService);
    await disabled.onModuleInit();
    expect(disabled.enabled).toBe(false);
    expect(() => disabled.getClient()).toThrow(/not configured/i);
  });
});
