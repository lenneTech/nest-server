/**
 * S3 downloads cannot exhaust the socket pool, whatever the caller does with the stream — against a REAL
 * S3-compatible store (RustFS).
 *
 * Production (12.8.x): a project controller delivered S3 bodies with a bare `stream.pipe(res)`. Every aborted
 * download left its body unread and undestroyed, holding one of the SDK's 50 sockets for good; once the pool was
 * full every S3 request waited forever (the health check stayed green), followed by a heap OOM hours later.
 *
 * The pool here is deliberately small (`maxSockets: 4`) and the idle time short, so the suite proves in seconds what
 * took production two days: aborts, dropped streams and load leave the pool usable, and a slow reader still gets the
 * whole file.
 *
 * Locally: the RustFS container on localhost:9102 (`pnpm run test:infra`); in CI the ci-rustfs service.
 */
import { createHash } from 'crypto';
import { createServer, get, type IncomingMessage, type Server } from 'http';
import { type AddressInfo } from 'net';
import { Writable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreS3Service } from '../src/core/common/services/core-s3.service';
import { pipeFileToResponse } from '../src/core/modules/file/core-file.controller';
import { dropS3Buckets } from './helpers/s3-test-cleanup';

import type { Response } from 'express';
import type { Readable } from 'stream';
import type { ConfigService } from '../src/core/common/services/config.service';

const RUN_BUCKET = `nest-server-e2e-dl-${Date.now()}-p${process.pid}`;
const MAX_SOCKETS = 4;
const IDLE_MS = 600;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createService(overrides: Record<string, unknown> = {}): CoreS3Service {
  const s3Config = {
    accessKeyId: process.env.S3_ACCESS_KEY || 'rustfs',
    autoCreateBucket: true,
    bucket: RUN_BUCKET,
    downloadIdleTimeoutMs: IDLE_MS,
    endpoint: process.env.S3_ENDPOINT || 'http://localhost:9102',
    forcePathStyle: true,
    maxSockets: MAX_SOCKETS,
    region: 'us-east-1',
    secretAccessKey: process.env.S3_SECRET_KEY || 'rustfs-secret',
    ...overrides,
  };
  const configService = {
    getFastButReadOnly: (key: string, defaultValue?: unknown) => (key === 's3' ? s3Config : defaultValue),
  } as unknown as ConfigService;
  return new CoreS3Service(configService);
}

/** A service with a pool of its own, initialized */
async function startService(): Promise<CoreS3Service> {
  const service = createService();
  await service.onModuleInit();
  return service;
}

/** Bytes of a stream, hashed while reading so 500 parallel downloads do not have to sit in memory */
async function sha256(stream: Readable): Promise<{ bytes: number; hash: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { bytes, hash: hash.digest('hex') };
}

/** Wait until the pool has no socket in use (or fail after `timeoutMs`) */
async function poolDrained(service: CoreS3Service, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stats = service.getSocketPoolStats();
    if (stats && stats.active === 0 && stats.waiting === 0) {
      return true;
    }
    await sleep(50);
  }
  return false;
}

/** Start a download over HTTP and abort it after the first bytes arrived */
function downloadAndAbort(port: number, path: string): Promise<void> {
  return new Promise((resolve) => {
    const request = get({ host: '127.0.0.1', path, port }, (response: IncomingMessage) => {
      response.once('data', () => {
        request.destroy();
        resolve();
      });
      response.once('error', () => resolve());
    });
    request.once('error', () => resolve());
  });
}

describe('S3 downloads keep the socket pool usable (real RustFS)', () => {
  let service: CoreS3Service;
  const big = Buffer.alloc(4 * 1024 * 1024);
  let bigHash: string;
  const small = Buffer.from('small object\n'.repeat(64));
  let smallHash: string;

  beforeAll(async () => {
    for (let i = 0; i < big.length; i += 4) {
      big.writeUInt32LE((i * 2654435761) >>> 0, i);
    }
    bigHash = createHash('sha256').update(big).digest('hex');
    smallHash = createHash('sha256').update(small).digest('hex');
    service = createService();
    try {
      await service.onModuleInit();
      await service.ensureBucket(RUN_BUCKET);
    } catch (error) {
      throw new Error(
        `No S3-compatible store reachable on ${process.env.S3_ENDPOINT || 'http://localhost:9102'}. ` +
          'Start the test infrastructure: pnpm run test:infra',
        { cause: error },
      );
    }
    await service.putObject('big.bin', big, 'application/octet-stream', big.length);
    await service.putObject('small.txt', small, 'text/plain', small.length);
  }, 60_000);

  afterAll(async () => {
    await dropS3Buckets(service.getClient(), [RUN_BUCKET]);
    await service.onApplicationShutdown();
  }, 60_000);

  /**
   * @regression   12.8.9 — a download stream obtained and dropped (never read, never destroyed) held its S3 socket
   *   for the life of the process; enough of them and every S3 request hung.
   * @seen-failing Return the raw body from CoreS3Service.getObject() (src/core/common/services/core-s3.service.ts) —
   *   registered as mutation `s3-get-object-body-unguarded` in tests/regression-mutations.json.
   */
  it('releases the sockets of dropped streams after the idle time, and serves the next download at once', async () => {
    // A pool of its own: if the guard is missing, this case fails fast at the drain check, and no later case
    // inherits a full pool to hang on
    const own = await startService();
    try {
      // Fill the whole pool with streams nobody reads
      for (let i = 0; i < MAX_SOCKETS; i++) {
        await own.getObject('big.bin');
      }
      expect(own.getSocketPoolStats().active).toBe(MAX_SOCKETS);

      expect(await poolDrained(own, IDLE_MS * 5)).toBe(true);

      const started = Date.now();
      const { body } = await own.getObject('big.bin');
      expect((await sha256(body)).hash).toBe(bigHash);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await own.onApplicationShutdown();
    }
  }, 30_000);

  describe('over HTTP', () => {
    let server: Server;
    let port: number;
    let httpService: CoreS3Service;

    beforeAll(async () => {
      httpService = await startService();
      server = createServer(async (req, res) => {
        if (req.url === '/wait') {
          // The abort layer ALONE: the store request is aborted when the client leaves. Whatever still arrives is
          // deliberately left unread, so a request that was not aborted shows up as a held socket
          const aborter = new AbortController();
          res.once('close', () => aborter.abort());
          await httpService.getObject('big.bin', { abortSignal: aborter.signal }).catch(() => null);
          return;
        }
        const { body } = await httpService.getObject('big.bin');
        if (req.url === '/raw') {
          // The project code that caused the outage: a bare pipe, nothing destroys the body on abort
          body.pipe(res);
        } else {
          pipeFileToResponse(body, res as unknown as Response);
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await httpService.onApplicationShutdown();
    });

    it('survives an abort storm of 3 × maxSockets bare-piped downloads: the pool drains and the next download is immediate', async () => {
      for (let round = 0; round < 3; round++) {
        await Promise.all(Array.from({ length: MAX_SOCKETS }, () => downloadAndAbort(port, '/raw')));
        // Each round may have to wait for the previous round's sockets: the idle guard frees them
        expect(await poolDrained(httpService, IDLE_MS * 5)).toBe(true);
      }

      const started = Date.now();
      const { body } = await httpService.getObject('big.bin');
      expect((await sha256(body)).bytes).toBe(big.length);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(await poolDrained(httpService, IDLE_MS * 5)).toBe(true);
    }, 60_000);

    /**
     * @regression   12.8.9 — a client that gave up while its download waited for a free S3 socket left a queued
     *   request behind; it later took a socket and a body for nobody. Under load each leak made the next downloads
     *   slower, and every waiter that gave up added one more (the production avalanche).
     * @seen-failing Ignore the abort signal in CoreS3Service.getObject() (src/core/common/services/core-s3.service.ts)
     *   — registered as mutation `s3-get-object-ignores-abort-signal` in tests/regression-mutations.json.
     */
    it('drops downloads whose clients left while waiting for a socket, and leaks nothing when the pool frees up', async () => {
      // Occupy the whole pool with slow but progressing readers
      const holders = await Promise.all(Array.from({ length: MAX_SOCKETS }, () => httpService.getObject('big.bin')));
      const pacers = holders.map(({ body }) => {
        body.pause();
        const tick = setInterval(() => body.read(), 50);
        return tick;
      });
      try {
        // Clients that give up before a socket is free
        const waiting = Array.from({ length: MAX_SOCKETS * 3 }, () =>
          new Promise<void>((resolve) => {
            const request = get({ host: '127.0.0.1', path: '/wait', port }, () => undefined);
            request.once('error', () => resolve());
            setTimeout(() => {
              request.destroy();
              resolve();
            }, 150);
          }),
        );
        await Promise.all(waiting);
        expect(httpService.getSocketPoolStats().active).toBe(MAX_SOCKETS);
      } finally {
        pacers.forEach(clearInterval);
        holders.forEach(({ body }) => body.destroy());
      }
      // Well below the idle time: no request of a gone client took a socket and kept it
      expect(await poolDrained(httpService, IDLE_MS / 2)).toBe(true);
    }, 30_000);

    /**
     * @regression   12.8.9 — pipeFileToResponse() must release the source when the response closes, not leave it to
     *   the idle guard: the time an aborted download holds its socket bounds how many aborts the pool can absorb.
     * @seen-failing Drop the release on client-gone in pipeFileToResponse() — the response's close destroy and the
     *   request/socket signals (src/core/modules/file/core-file.controller.ts) — registered as mutation
     *   `pipe-file-to-response-keeps-source` in tests/regression-mutations.json.
     */
    it('releases the sockets of aborted downloads through pipeFileToResponse() at once, without waiting for the idle time', async () => {
      await Promise.all(Array.from({ length: MAX_SOCKETS * 3 }, () => downloadAndAbort(port, '/guarded')));
      // Well below the idle time: the response's close destroyed the source
      expect(await poolDrained(httpService, IDLE_MS / 2)).toBe(true);
    }, 30_000);
  });

  it('delivers 500 parallel downloads (far more than maxSockets) completely and byte-identical, with bounded heap', async () => {
    const heapBefore = process.memoryUsage().heapUsed;
    const results = await Promise.all(
      Array.from({ length: 500 }, async (_, i) => {
        const key = i % 10 === 0 ? 'big.bin' : 'small.txt';
        const { body } = await service.getObject(key);
        return { expected: key === 'big.bin' ? bigHash : smallHash, ...(await sha256(body)) };
      }),
    );
    for (const result of results) {
      expect(result.hash).toBe(result.expected);
    }
    // 50 × 4 MB went through; nothing of it may stay behind
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
    expect(heapGrowth).toBeLessThan(150 * 1024 * 1024);
    expect(await poolDrained(service, IDLE_MS * 5)).toBe(true);
  }, 120_000);

  it('never cuts off a slow reader that keeps reading, although the transfer lasts many idle periods', async () => {
    const { body } = await service.getObject('big.bin');
    const hash = createHash('sha256');
    let bytes = 0;
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      const slow = new Writable({
        highWaterMark: 1,
        write(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          bytes += chunk.length;
          // Each chunk takes a fraction of the idle time, the whole download several idle periods
          setTimeout(callback, Math.floor(IDLE_MS / 24));
        },
      });
      body.on('error', reject);
      slow.on('finish', resolve);
      body.pipe(slow);
    });
    expect(bytes).toBe(big.length);
    expect(hash.digest('hex')).toBe(bigHash);
    expect(Date.now() - started).toBeGreaterThan(IDLE_MS * 2);
  }, 60_000);
});
