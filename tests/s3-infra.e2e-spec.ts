import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreS3Service } from '../src/core/common/services/core-s3.service';

import type { ConfigService } from '../src/core/common/services/config.service';

/**
 * Round-trip tests against a REAL S3-compatible store (RustFS).
 * Locally: dedicated container on localhost:9102; in CI: the ci-rustfs service.
 * Isolation: unique bucket per run, removed afterwards.
 */
const RUN_BUCKET = `nest-server-e2e-${Date.now()}-p${process.pid}`;

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
    await service.ensureBucket(RUN_BUCKET);
  });

  afterAll(async () => {
    try {
      await service.deleteObject('smoke/hello.txt');
    } catch {
      // already gone
    }
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

  it('is inert without config', async () => {
    const disabled = new CoreS3Service({
      getFastButReadOnly: () => undefined,
    } as unknown as ConfigService);
    await disabled.onModuleInit();
    expect(disabled.enabled).toBe(false);
    expect(() => disabled.getClient()).toThrow(/not configured/i);
  });
});
