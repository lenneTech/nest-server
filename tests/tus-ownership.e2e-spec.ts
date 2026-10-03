import * as http from 'http';
import mongoose, { Connection } from 'mongoose';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { IServerOptions } from '../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { setTenantContextResolver } from '../src/core/common/services/core-tenant-context.registry';
import { CoreFileService } from '../src/core/modules/file/core-file.service';
import { CoreTusService } from '../src/core/modules/tus/core-tus.service';
import { createFixtureDir, removeFixtureDir } from './helpers/tmp-fixtures';

/**
 * WHO owns a tus upload — during it, and after it.
 *
 * `tus.roles` (default `S_USER` since 11.33.0) is the coarse gate: it decides who may reach the tus
 * endpoint at all. It says nothing about WHICH upload a caller may touch, and the tus protocol is
 * built entirely around a per-upload URL: after `POST /tus` the client is handed
 * `/tus/<id>` and uses it for `HEAD` (offset), `PATCH` (append bytes) and `DELETE` (terminate,
 * enabled by default). Every one of those carried only the coarse gate.
 *
 * Two consequences, and they pull in opposite directions:
 *
 *  1. **Nothing recorded the uploader.** The finished file's metadata carried `originalMetadata`,
 *     `tusUploadId` and `uploadedAt` — no owner. So the per-file ownership rule the framework's own
 *     documentation prescribes (`metadata.ownerId === currentUser.id`, see
 *     `CoreFileService.checkRights()`) can never authorize a tus-uploaded file: it fails CLOSED for
 *     everyone except ADMIN. A project following the documented pattern ends up with files nobody
 *     can download.
 *
 *  2. **Nothing checked the toucher.** Any other authenticated caller who learns an upload id can
 *     append bytes to it (`PATCH`) or destroy it (`DELETE`). Appending is the sharper one: the bytes
 *     are then migrated into the file store under the ORIGINAL uploader's filename, so the attacker
 *     writes content that the victim, and everyone authorized to read the victim's files, receives
 *     as the victim's own.
 *
 * The ids are random (`@tus/server` generates them), so (2) needs the id to leak — a shared log, a
 * proxy access log, a client-side error report. "Hard to guess" is not an authorization rule, and for
 * medical data an upload path whose only protection is the secrecy of a URL is exactly what an audit
 * flags.
 *
 * WHAT THIS HARNESS SIMULATES, and what it does not: the request's `user` is attached by the test's
 * HTTP server from a header, which is what the role guard does upstream on the real controller path
 * (`CoreTusController.handleTus(req, res)` receives the Express request with `req.user` set). Nothing
 * else is faked — the real `CoreTusService`, the real `@tus/server`, real HTTP, real GridFS.
 */

/** Attaches `req.user` the way the upstream role guard does, so the service sees a caller. */
const USER_HEADER = 'x-test-user';

class TestFileService extends CoreFileService {
  constructor(connection: Connection, configService: ConfigService) {
    super(connection, 'fs', { configService });
  }

  /** Exposes the raw metadata a per-file rule would read. */
  rawById(id: string) {
    return this.getRawFileInfo(id);
  }
}

describe('TUS upload ownership (e2e)', () => {
  let connection: Connection;
  let configService: ConfigService;
  let tusService: CoreTusService;
  let fileService: TestFileService;
  let previousConfig: Partial<IServerOptions>;
  let fixtureDir: string;
  let url: string;
  let closeServer: () => Promise<void>;

  const testId = `tus-own-${Date.now()}-p${process.pid}`;
  const ALICE = '6a0000000000000000000a11';
  const BOB = '6a0000000000000000000b22';

  const tusRequest = (options: {
    body?: Buffer;
    headers?: Record<string, string>;
    method: string;
    path: string;
    user?: string;
  }): Promise<{ headers: http.IncomingHttpHeaders; statusCode: number }> =>
    new Promise((resolve, reject) => {
      const { port } = new URL(url);
      const req = http.request(
        {
          headers: {
            'Tus-Resumable': '1.0.0',
            ...(options.user ? { [USER_HEADER]: options.user } : {}),
            ...options.headers,
          },
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

  /** Create an upload as `user`; returns its id (the per-upload URL's last segment). */
  const createUpload = async (user: string, filename: string, length: number): Promise<string> => {
    const created = await tusRequest({
      headers: {
        'Upload-Length': String(length),
        'Upload-Metadata':
          `filename ${Buffer.from(filename).toString('base64')},` +
          `filetype ${Buffer.from('text/plain').toString('base64')}`,
      },
      method: 'POST',
      path: '/tus',
      user,
    });
    expect(created.statusCode, 'tus creation').toBe(201);
    return (created.headers.location as string).split('/').pop() as string;
  };

  beforeAll(async () => {
    previousConfig = { ...(envConfig as Partial<IServerOptions>) };
    fixtureDir = await createFixtureDir(testId);

    ConfigService.setConfig({ ...(previousConfig as any), file: { storage: 'gridfs' } } as IServerOptions, {
      reInit: true,
    });
    configService = new ConfigService(ConfigService.configFastButReadOnly as any, { warn: false });

    connection = (await mongoose.createConnection(process.env.MONGODB_URI).asPromise()) as any;
    fileService = new TestFileService(connection, configService);

    tusService = new CoreTusService(connection, { configService });
    tusService.configure({ uploadDir: path.join(fixtureDir, 'tus') });
    await tusService.onModuleInit();

    const server = http.createServer((req, res) => {
      // What the role guard does upstream on the real controller path.
      const user = req.headers[USER_HEADER];
      if (typeof user === 'string' && user) {
        (req as any).user = { id: user, roles: [] };
      }
      void tusService.getServer().handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    closeServer = async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await tusService.onModuleDestroy();
    };
  }, 120_000);

  afterAll(async () => {
    await closeServer?.();
    await connection?.close();
    await removeFixtureDir(fixtureDir);
    ConfigService.setConfig(previousConfig as IServerOptions, { reInit: true });
  }, 120_000);

  /**
   * THESIS: the finished file records WHO uploaded it, so the per-file ownership rule the framework
   * documents can actually authorize a tus-uploaded file.
   *
   * @regression   11.35.0 — a tus upload recorded no owner, so the documented ownership rule failed
   *   closed for every tus-uploaded file (admin-only in practice).
   * @seen-failing Delete the `ownerId` entry from the `fileMetadata` object in
   *   `onUploadComplete()` in `src/core/modules/tus/core-tus.service.ts` — registered as mutation
   *   `tus-upload-records-no-owner` in `tests/regression-mutations.json`.
   */
  it('records the uploading user on the finished file', async () => {
    const filename = `${testId}-owned.txt`;
    const payload = Buffer.from('alice bytes');
    const uploadId = await createUpload(ALICE, filename, payload.length);

    const patched = await tusRequest({
      body: payload,
      headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' },
      method: 'PATCH',
      path: `/tus/${uploadId}`,
      user: ALICE,
    });
    expect(patched.statusCode, 'tus completion').toBe(204);

    const info = await fileService.getFileInfoByName(filename);
    expect(info, 'the finished file must exist').toBeTruthy();

    const raw = await fileService.rawById(info.id);
    expect(String(raw?.metadata?.ownerId), 'the documented ownership key').toBe(ALICE);
    // The pre-existing bookkeeping must stay — a project may already read it.
    expect(raw?.metadata?.tusUploadId).toBe(uploadId);
  });

  /**
   * THESIS: an upload belongs to the caller who created it. Another authenticated caller may not read
   * its offset, append to it, or terminate it.
   *
   * The refusal is a **404**, not a 403 — the same policy `CoreFileService.checkRights()` states for
   * files: a refusal must be indistinguishable from an upload that is not there, or the endpoint
   * becomes an existence oracle for ids that are not secrets.
   *
   * @regression   11.35.0 — HEAD / PATCH / DELETE on a tus upload carried only the coarse `tus.roles`
   *   gate, so any authenticated caller who learned an id could read its offset, append bytes to
   *   somebody else's upload, or destroy it.
   * @seen-failing Make `assertUploadOwnership()` in `src/core/modules/tus/core-tus.service.ts`
   *   return immediately — registered as mutation `tus-any-user-touches-any-upload` in
   *   `tests/regression-mutations.json`.
   */
  it('refuses a foreign caller on HEAD, PATCH and DELETE of an upload they do not own', async () => {
    const payload = Buffer.from('alice private bytes');
    const uploadId = await createUpload(ALICE, `${testId}-private.txt`, payload.length);

    // Bob knows the id (a leaked log line is enough) but did not create the upload.
    expect((await tusRequest({ method: 'HEAD', path: `/tus/${uploadId}`, user: BOB })).statusCode).toBe(404);

    const bobPatch = await tusRequest({
      body: Buffer.from('bob bytes'),
      headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' },
      method: 'PATCH',
      path: `/tus/${uploadId}`,
      user: BOB,
    });
    expect(bobPatch.statusCode, 'a foreign PATCH would substitute the file content').toBe(404);

    expect((await tusRequest({ method: 'DELETE', path: `/tus/${uploadId}`, user: BOB })).statusCode).toBe(404);

    // …and the owner is entirely unaffected: the upload is still hers and still resumable.
    const aliceHead = await tusRequest({ method: 'HEAD', path: `/tus/${uploadId}`, user: ALICE });
    expect(aliceHead.statusCode, 'the owner must not be locked out').toBe(200);
    expect(aliceHead.headers['upload-offset'], 'no foreign bytes were appended').toBe('0');

    const alicePatch = await tusRequest({
      body: payload,
      headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' },
      method: 'PATCH',
      path: `/tus/${uploadId}`,
      user: ALICE,
    });
    expect(alicePatch.statusCode).toBe(204);
  });

  /**
   * THESIS: an upload created WITHOUT a user (a project that opened the gate with
   * `tus.roles: [S_EVERYONE]` for a public form) stays reachable — the ownership rule must not
   * retroactively lock out a configuration the framework documents as supported.
   */
  it('leaves an owner-less upload reachable, so a public form still works', async () => {
    const payload = Buffer.from('anonymous bytes');
    const uploadId = await createUpload(undefined as any, `${testId}-public.txt`, payload.length);

    expect((await tusRequest({ method: 'HEAD', path: `/tus/${uploadId}` })).statusCode).toBe(200);
    const patched = await tusRequest({
      body: payload,
      headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' },
      method: 'PATCH',
      path: `/tus/${uploadId}`,
    });
    expect(patched.statusCode).toBe(204);
  });

  // ---------------------------------------------------------------------------------------------
  // The tenant of an upload (11.41.9) — only with multi-tenancy active
  // ---------------------------------------------------------------------------------------------

  const TENANT_A = 'tenant-a';

  /** Create, append and finish an upload; returns the creation status and the finished file's raw metadata. */
  const uploadWith = async (options: { extraMetadata?: string; tenantHeader?: string; user: string }) => {
    const filename = `${testId}-tenant-${Math.random().toString(36).slice(2, 8)}.txt`;
    const payload = Buffer.from('tenant bytes');
    const created = await tusRequest({
      headers: {
        'Upload-Length': String(payload.length),
        'Upload-Metadata':
          `filename ${Buffer.from(filename).toString('base64')},` +
          `filetype ${Buffer.from('text/plain').toString('base64')}` +
          (options.extraMetadata ? `,${options.extraMetadata}` : ''),
        ...(options.tenantHeader ? { 'x-tenant-id': options.tenantHeader } : {}),
      },
      method: 'POST',
      path: '/tus',
      user: options.user,
    });
    if (created.statusCode !== 201) {
      return { metadata: undefined, status: created.statusCode };
    }
    const uploadId = (created.headers.location as string).split('/').pop() as string;
    const patched = await tusRequest({
      body: payload,
      headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' },
      method: 'PATCH',
      path: `/tus/${uploadId}`,
      user: options.user,
    });
    expect(patched.statusCode, 'tus completion').toBe(204);
    const info = await fileService.getFileInfoByName(filename);
    return { metadata: (await fileService.rawById(info.id))?.metadata, status: created.statusCode };
  };

  /** Runs `body` with multi-tenancy active and a resolver that knows ALICE as a member of TENANT_A only. */
  const withTenancy = async (body: () => Promise<void>) => {
    const before = ConfigService.configFastButReadOnly;
    ConfigService.setConfig({ ...(before as any), multiTenancy: {} } as IServerOptions, { reInit: true });
    setTenantContextResolver({
      resolve: async (user, header) =>
        user?.id === ALICE && header === TENANT_A ? { tenantId: TENANT_A, tenantRole: 'member' } : {},
    });
    try {
      await body();
    } finally {
      setTenantContextResolver(undefined);
      ConfigService.setConfig(before as IServerOptions, { reInit: true });
    }
  };

  /** `ltTenantId` smuggled in through the client-controlled Upload-Metadata header. */
  const SPOOFED_TENANT = `ltTenantId ${Buffer.from('tenant-victim').toString('base64')}`;

  /**
   * THESIS: with multi-tenancy active, a tus-uploaded file records the tenant it was uploaded into —
   * validated against an active membership — so the file module's 'tenant' access preset and every
   * tenant-scoped quota can see it.
   *
   * @regression   11.41.9 — tus uploads carried no tenant at all, so in a multi-tenant project every
   *   tus-uploaded file sat outside tenant scoping and outside any per-tenant quota.
   * @seen-failing Delete the `tenantId` entry from the `fileMetadata` object in `onUploadComplete()`
   *   in src/core/modules/tus/core-tus.service.ts — registered as mutation
   *   `tus-tenant-not-carried-to-file` in tests/regression-mutations.json.
   */
  it('records the validated tenant on the finished file when multi-tenancy is active', async () => {
    await withTenancy(async () => {
      const { metadata, status } = await uploadWith({ tenantHeader: TENANT_A, user: ALICE });
      expect(status).toBe(201);
      expect(metadata?.tenantId).toBe(TENANT_A);
      expect(String(metadata?.ownerId)).toBe(ALICE);
    });
  });

  /**
   * THESIS: the tenant header is never taken on trust. The tus routes carry @SkipTenantCheck(), so
   * nothing upstream validated it — a header naming a tenant the caller is not a member of refuses the
   * upload instead of placing a file in somebody else's tenant.
   *
   * @regression   11.41.9 — a tenant taken from an unvalidated header lets any authenticated caller
   *   write files into a foreign tenant.
   * @seen-failing Accept an unresolved tenant in `resolveUploadTenantId()` in
   *   src/core/modules/tus/core-tus.service.ts — registered as mutation
   *   `tus-tenant-header-unvalidated` in tests/regression-mutations.json.
   */
  it('refuses an upload into a tenant the caller is not a member of', async () => {
    await withTenancy(async () => {
      const { status } = await uploadWith({ tenantHeader: TENANT_A, user: BOB });
      expect(status).toBe(403);
    });
  });

  /**
   * THESIS: the tenant key is framework-owned. A client that names a tenant through its own
   * Upload-Metadata gets none — with or without multi-tenancy.
   *
   * @regression   11.41.9 — merging instead of overwriting `ltTenantId` lets a client place its file
   *   in any tenant through the Upload-Metadata header.
   * @seen-failing Drop the `ltTenantId` overwrite from `onUploadCreate()` in
   *   src/core/modules/tus/core-tus.service.ts — registered as mutation
   *   `tus-tenant-taken-from-client` in tests/regression-mutations.json.
   */
  it('ignores a tenant the client smuggles into Upload-Metadata', async () => {
    await withTenancy(async () => {
      const { metadata } = await uploadWith({ extraMetadata: SPOOFED_TENANT, user: ALICE });
      expect(metadata?.tenantId).toBeUndefined();
    });
    const { metadata } = await uploadWith({ extraMetadata: SPOOFED_TENANT, user: ALICE });
    expect(metadata?.tenantId).toBeUndefined();
  });

  /**
   * THESIS: tenant handling stays OPTIONAL — without multi-tenancy nothing about an upload changes,
   * even when a tenant header and a registered resolver are present.
   */
  it('changes nothing without multi-tenancy, header or not', async () => {
    setTenantContextResolver({ resolve: async () => ({ tenantId: TENANT_A }) });
    try {
      const { metadata, status } = await uploadWith({ tenantHeader: TENANT_A, user: BOB });
      expect(status).toBe(201);
      expect(metadata?.tenantId).toBeUndefined();
    } finally {
      setTenantContextResolver(undefined);
    }
  });

  it('paired control: without a tenant header an upload stays tenant-less even with multi-tenancy', async () => {
    await withTenancy(async () => {
      const { metadata, status } = await uploadWith({ user: ALICE });
      expect(status).toBe(201);
      expect(metadata?.tenantId).toBeUndefined();
    });
  });
});
