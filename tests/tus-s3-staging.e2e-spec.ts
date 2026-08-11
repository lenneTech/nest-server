import { Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as http from 'http';
import mongoose, { Connection } from 'mongoose';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import envConfig from '../src/config.env';
import { IServerOptions } from '../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { CoreS3Service } from '../src/core/common/services/core-s3.service';
import { S3_FILES_COLLECTION } from '../src/core/modules/file/s3-file.helper';
import { CoreTusService } from '../src/core/modules/tus/core-tus.service';
import { createFixtureDir, removeFixtureDir } from './helpers/tmp-fixtures';
import { dropS3Buckets } from './helpers/s3-test-cleanup';

/**
 * `tus.s3Staging` against a REAL S3-compatible store (RustFS).
 *
 * This is the executable form of one of the release's headline claims: "resumable uploads survive
 * replica restarts and need no sticky sessions". `tests/unit/s3-enabled-contract.spec.ts` only
 * asserts the BOOLEAN derivation (`s3` configured → staging on); nothing exercised `@tus/s3-store`
 * actually holding an in-progress upload. A staging path that silently fell back to local disk
 * would satisfy every existing assertion and break exactly the property being advertised — the
 * in-progress state would be pod-local again, so a resumed upload landing on another replica would
 * 404 and a restart would lose the transfer.
 *
 * The load-bearing case therefore hands the SECOND half of an upload to a SECOND, independently
 * constructed service instance — two objects, two HTTP servers, one S3 — which is the shape of two
 * pods behind a load balancer. A local-disk store cannot pass it: instance B has never seen the
 * upload. It is deliberately the same argument `multi-replica.e2e-spec.ts` makes for cron and rate
 * limits.
 *
 * The documented fallback is covered too: with the OPTIONAL peer `@tus/s3-store` missing, the
 * framework warns and stages on local disk rather than failing the boot.
 *
 * Locally: dedicated RustFS container on localhost:9102; in CI: the ci-rustfs service. The suite
 * FAILS rather than skips when the store is missing — a silently skipped storage test is how an
 * untested driver ships.
 */
const RUN_BUCKET = `nest-server-tus-staging-${Date.now()}-p${process.pid}`;

// The image tag must stay identical to the pin in scripts/test-infra.mjs and
// .github/actions/test-infra/action.yml. A hint that says `:latest` starts a
// container `containerMatches()` rejects, so the next `pnpm test` tears it down
// and recreates it — for a developer who followed the instructions.
const START_CONTAINER
  = 'docker run -d --name nest-server-2985-rustfs -p 9102:9000 -e RUSTFS_ROOT_USER=rustfs '
    + '-e RUSTFS_ROOT_PASSWORD=rustfs-secret -e RUSTFS_VOLUMES=/data rustfs/rustfs:1.0.0-rc.1 server /data';

const s3Config = {
  accessKeyId: process.env.S3_ACCESS_KEY || 'rustfs',
  autoCreateBucket: true,
  bucket: RUN_BUCKET,
  endpoint: process.env.S3_ENDPOINT || 'http://localhost:9102',
  forcePathStyle: true,
  region: 'us-east-1',
  secretAccessKey: process.env.S3_SECRET_KEY || 'rustfs-secret',
};

/** Exposes the protected staging internals, and lets the missing-peer case be simulated */
class TestTusService extends CoreTusService {
  /** When true, `importS3Store()` rejects exactly as a missing optional peer would */
  peerMissing = false;

  get stagedInS3(): boolean {
    return !!this.s3Store;
  }

  override importS3Store(): Promise<any> {
    return this.peerMissing ? Promise.reject(new Error("Cannot find module '@tus/s3-store'")) : super.importS3Store();
  }
}

/** One "replica": a tus service plus its own HTTP server */
interface Replica {
  close: () => Promise<void>;
  service: TestTusService;
  url: string;
}

describe('TUS S3 staging (real RustFS)', () => {
  let connection: Connection;
  let configService: ConfigService;
  let s3Service: CoreS3Service;
  let previousConfig: Partial<IServerOptions>;
  let fixtureDir: string;
  const replicas: Replica[] = [];
  const testId = `tus-s3-${Date.now()}`;

  /** Boot a replica with its OWN upload directory, so "local disk was not used" is checkable */
  const startReplica = async (label: string, options: { peerMissing?: boolean } = {}): Promise<Replica> => {
    const uploadDir = path.join(fixtureDir, `${label}-tus`);
    const service = new TestTusService(connection, { configService, s3Service });
    service.peerMissing = !!options.peerMissing;
    service.configure({ uploadDir });
    await service.onModuleInit();

    const server = http.createServer((req, res) => {
      void service.getServer().handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };

    const replica: Replica = {
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await service.onModuleDestroy();
      },
      service,
      url: `http://127.0.0.1:${port}`,
    };
    replicas.push(replica);
    return replica;
  };

  /** Minimal tus client: one request, headers + status back, body optional */
  const tusRequest = (
    replica: Replica,
    options: { body?: Buffer; headers?: Record<string, string>; method: string; path: string },
  ): Promise<{ headers: http.IncomingHttpHeaders; statusCode: number }> =>
    new Promise((resolve, reject) => {
      const { port } = new URL(replica.url);
      const req = http.request(
        {
          headers: { 'Tus-Resumable': '1.0.0', ...options.headers },
          hostname: '127.0.0.1',
          method: options.method,
          path: options.path,
          port,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ headers: res.headers, statusCode: res.statusCode }));
        },
      );
      req.on('error', reject);
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });

  const createUpload = async (replica: Replica, filename: string, size: number): Promise<string> => {
    const response = await tusRequest(replica, {
      headers: {
        'Upload-Length': String(size),
        'Upload-Metadata': `filename ${Buffer.from(filename).toString('base64')},`
          + `filetype ${Buffer.from('application/octet-stream').toString('base64')}`,
      },
      method: 'POST',
      path: '/tus',
    });
    expect(response.statusCode, 'tus creation').toBe(201);
    const location = response.headers.location as string;
    expect(location).toBeDefined();
    return location.split('/').pop();
  };

  const patch = (replica: Replica, uploadId: string, offset: number, body: Buffer) =>
    tusRequest(replica, {
      body,
      headers: {
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(offset),
      },
      method: 'PATCH',
      path: `/tus/${uploadId}`,
    });

  /** Names of the files a replica has staged on its own disk */
  const localStagedFiles = async (label: string): Promise<string[]> => {
    try {
      return (await fs.readdir(path.join(fixtureDir, `${label}-tus`))).sort();
    } catch {
      return [];
    }
  };

  beforeAll(async () => {
    fixtureDir = await createFixtureDir('nest-server-tus-s3-');

    previousConfig = ConfigService.configFastButReadOnly as Partial<IServerOptions>;
    ConfigService.setConfig({ ...(previousConfig as any), file: { storage: 's3' }, s3: s3Config } as IServerOptions, {
      reInit: true,
    });
    configService = new ConfigService(ConfigService.configFastButReadOnly as any, { warn: false });

    s3Service = new CoreS3Service(configService);
    try {
      await s3Service.onModuleInit();
      await s3Service.ensureBucket(RUN_BUCKET);
    } catch (error) {
      // A refused connection arrives as an AggregateError with an EMPTY message — the only
      // readable part is `code`. Fail loudly with the exact command, never skip.
      const reason
        = error instanceof Error ? error.message || (error as { code?: string }).code || error.name : String(error);
      throw new Error(
        `No S3-compatible store reachable on ${s3Config.endpoint} (${reason}). `
        + `Start the test container:\n  ${START_CONTAINER}`, { cause: error },
      );
    }

    connection = mongoose.createConnection(envConfig.mongoose.uri);
    await connection.asPromise();
  }, 120_000);

  afterAll(async () => {
    for (const replica of replicas) {
      await replica.close().catch(() => undefined);
    }
    await connection?.db?.collection(S3_FILES_COLLECTION).deleteMany({ filename: { $regex: testId } });
    await dropS3Buckets(s3Service?.getClient(), [RUN_BUCKET]);
    await s3Service?.onApplicationShutdown();
    await connection?.close();
    await removeFixtureDir(fixtureDir);
    ConfigService.setConfig(previousConfig as IServerOptions, { reInit: true });
  }, 120_000);

  it('stages in S3 by default when s3 is configured', async () => {
    const replica = await startReplica('default');
    expect(replica.service.stagedInS3).toBe(true);
  });

  it('keeps an in-progress upload in S3 and nothing on local disk', async () => {
    const replica = await startReplica('inprogress');
    const filename = `${testId}-inprogress.bin`;
    const payload = Buffer.alloc(32 * 1024, 'a');

    const uploadId = await createUpload(replica, filename, payload.length);

    // `@tus/s3-store` records the upload's own metadata as an `<id>.info` object. That object IS
    // the "no sticky sessions" property: it is what a different replica reads to learn the upload
    // exists and how far it got.
    expect(await s3Service.objectExists(`${uploadId}.info`)).toBe(true);
    expect(await localStagedFiles('inprogress')).toEqual([]);

    // Half the bytes, then check again: still S3, still nothing on disk.
    expect((await patch(replica, uploadId, 0, payload.subarray(0, payload.length / 2))).statusCode).toBe(204);
    expect(await s3Service.objectExists(`${uploadId}.info`)).toBe(true);
    expect(await localStagedFiles('inprogress')).toEqual([]);

    // Finish it so the staging objects do not outlive the test.
    expect((await patch(replica, uploadId, payload.length / 2, payload.subarray(payload.length / 2))).statusCode).toBe(
      204,
    );
  }, 60_000);

  it('resumes an upload on a DIFFERENT replica, which is what removes the need for sticky sessions', async () => {
    // The acceptance case. Two independently constructed services, two HTTP servers, one S3 — the
    // shape of two pods. With local-disk staging instance B has never seen this upload and the
    // PATCH cannot succeed, so this case is exactly the one that fails when staging silently falls
    // back.
    const replicaA = await startReplica('resume-a');
    const replicaB = await startReplica('resume-b');
    const filename = `${testId}-resumed.bin`;
    const payload = Buffer.alloc(48 * 1024, 'b');
    const half = payload.length / 2;

    const uploadId = await createUpload(replicaA, filename, payload.length);
    expect((await patch(replicaA, uploadId, 0, payload.subarray(0, half))).statusCode).toBe(204);

    // B has never handled a byte of this upload, and its own disk is empty…
    expect(await localStagedFiles('resume-b')).toEqual([]);
    // …yet it knows the offset, because the state lives in S3.
    const head = await tusRequest(replicaB, { method: 'HEAD', path: `/tus/${uploadId}` });
    expect(head.statusCode).toBe(200);
    expect(head.headers['upload-offset']).toBe(String(half));

    // …and it can finish the transfer.
    const finish = await patch(replicaB, uploadId, half, payload.subarray(half));
    expect(finish.statusCode).toBe(204);

    // The completed file landed in the permanent S3 file store with its bytes intact…
    const doc = await connection.db.collection(S3_FILES_COLLECTION).findOne({ filename });
    expect(doc, 'completed upload must be recorded in the S3 file store').toBeTruthy();
    expect(doc.length).toBe(payload.length);
    expect(await s3Service.objectExists(String(doc._id))).toBe(true);

    // …and the staging objects are GONE. This is the regression guard for a leak that doubled
    // stored bytes for every upload: `@tus/s3-store` v2's `remove()` aborts the multipart upload
    // first, which answers `NoSuchUpload` once the upload has completed, and its catch tests
    // `error.code` — an AWS SDK *v2* field that v3 does not set — so the error escaped and the
    // deletion never ran. `stagingBucket` defaults to `bucket`, so the file bucket accumulated a
    // second copy of every file, forever; a lifecycle rule for INCOMPLETE multipart uploads (the
    // remedy the tus README documents) does not reach completed objects.
    expect(await s3Service.objectExists(uploadId), 'staged object must not survive completion').toBe(false);
    expect(await s3Service.objectExists(`${uploadId}.info`), 'staged .info must not survive completion').toBe(false);

    // Neither replica ever touched its local disk.
    expect(await localStagedFiles('resume-a')).toEqual([]);
    expect(await localStagedFiles('resume-b')).toEqual([]);
  }, 60_000);

  it('warns and falls back to local disk when the optional peer is missing, instead of failing the boot', async () => {
    // The documented behaviour: `@tus/s3-store` is an OPTIONAL peer, so its absence must degrade
    // the deployment (staging becomes pod-local again) and never prevent it from starting. A boot
    // failure here would take down a service whose uploads would otherwise work.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const replica = await startReplica('nopeer', { peerMissing: true });

      // Booted, and serving.
      expect(replica.service.getServer()).not.toBeNull();
      expect(replica.service.stagedInS3).toBe(false);
      expect(
        warn.mock.calls.filter(([message]) => String(message).includes('@tus/s3-store')),
        'the operator must be told why staging is pod-local',
      ).toHaveLength(1);

      const filename = `${testId}-nopeer.bin`;
      const payload = Buffer.alloc(16 * 1024, 'c');
      const uploadId = await createUpload(replica, filename, payload.length);

      // Now the in-progress upload IS on local disk — the degraded, single-replica behaviour.
      expect((await patch(replica, uploadId, 0, payload.subarray(0, payload.length / 2))).statusCode).toBe(204);
      expect(await localStagedFiles('nopeer')).toContain(uploadId);
      expect(await s3Service.objectExists(`${uploadId}.info`)).toBe(false);

      // …and the finished file still reaches the permanent S3 store, which is a separate concern
      // from where the chunks were staged.
      expect(
        (await patch(replica, uploadId, payload.length / 2, payload.subarray(payload.length / 2))).statusCode,
      ).toBe(204);
      const doc = await connection.db.collection(S3_FILES_COLLECTION).findOne({ filename });
      expect(doc?.length).toBe(payload.length);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);

  it('honours an explicit s3Staging: false even with S3 configured', async () => {
    const uploadDir = path.join(fixtureDir, 'explicit-off-tus');
    const service = new TestTusService(connection, { configService, s3Service });
    service.configure({ s3Staging: false, uploadDir });
    await service.onModuleInit();
    replicas.push({ close: () => service.onModuleDestroy(), service, url: '' });

    expect(service.stagedInS3).toBe(false);
  });
});
