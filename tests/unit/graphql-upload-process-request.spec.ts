import express from 'express';
import graphqlUploadExpress from 'graphql-upload/graphqlUploadExpress.mjs';
import Upload from 'graphql-upload/Upload.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { processGraphQlUploadRequest } from '../../src/core/common/helpers/graphql-upload.helper';
import { CRASH_MAP, CRASH_OPERATIONS, graphQlMultipart, postMultipart } from '../helpers/graphql-multipart';

import type { MiddlewareConsumer } from '@nestjs/common';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';

/**
 * The framework's GraphQL multipart processing (`processGraphQlUploadRequest`), driven with raw multipart requests
 * through graphql-upload's own `graphqlUploadExpress()` — the middleware `CoreModule` registers for `/graphql`, in
 * front of every guard.
 *
 * GHSA-5vm7-vc2x-p3w2 (high): graphql-upload < 18.0.2 set an `Upload` at whatever `map` path the client named. A path
 * INTO an already placed upload replaced its `reject` (or `file`), and when the request ended without that file the
 * parser's `finish` handler threw `TypeError: upload.reject is not a function` — outside any request, so an uncaught
 * exception, and `installProcessDiagnostics()` exits on that. One anonymous request took the server down. A path with a
 * `__proto__` key gave a client-supplied object an `Upload` prototype, so it passed the scalar's `instanceof` check.
 * GHSA-qwwm-252j-9whw (medium): a second file field with the name of an already resolved upload created a second
 * temporary file and replaced the reference to the first, which was then never released.
 *
 * The path cases mirror the seven of the upstream fix, and each SENDS every file its `map` names: without the fix they
 * fail on the missing 400, not by crashing this worker. The proof that the unpatched path does crash a process runs in
 * a child process (`fixtures/graphql-upload-crash-child.ts`), with the framework's real diagnostics installed, so it
 * does not depend on reading the code.
 *
 * @regression   12.10.0 — graphql-upload 17.1.0's `processRequest` (GHSA-5vm7-vc2x-p3w2, GHSA-qwwm-252j-9whw): a `map`
 *   path into a placed upload or with a `__proto__` key was accepted, a duplicate file field replaced the resolved
 *   file, and `CoreModule` registered `graphqlUploadExpress()` with that default.
 * @seen-failing Registered in tests/regression-mutations.json: `graphql-upload-map-path-unchecked` (both path checks
 *   gone — the 17.1.0 behaviour: every path case red with a 200 or 500 where 400 was expected, and the framework-mode
 *   child process dies with the uncaught TypeError), `graphql-upload-map-proto-key-allowed` (only the `__proto__`
 *   check gone: the `variables.file.__proto__` case answers 500), `graphql-upload-map-traverses-upload` (only the
 *   traversal check gone: the other path cases and the child), `graphql-upload-duplicate-file-field-kept` (the
 *   duplicate-field case: the upload's `file` is the second file and a temporary file stays behind) and
 *   `graphql-upload-wiring-default-process-request` (`CoreModule` back on graphql-upload's default: the wiring case).
 */

/** What the echo handler reports for one upload. */
interface EchoedUpload {
  content: string;
  filename: string;
  /** `upload.file` is the file the upload's promise resolved with — false once a duplicate replaced it. */
  resolvedFileIsCurrent: boolean;
}

const ROOT = join(__dirname, '..', '..');
const CHILD_FIXTURE = join(__dirname, 'fixtures', 'graphql-upload-crash-child.ts');

/** Reads an upload the way a resolver does: await the promise, stream the file. */
async function readUpload(upload: Upload): Promise<EchoedUpload> {
  const file = (await upload.promise) as { createReadStream: () => Readable; filename: string };
  const chunks: Buffer[] = [];
  for await (const chunk of file.createReadStream()) {
    chunks.push(Buffer.from(chunk));
  }
  return {
    content: Buffer.concat(chunks).toString('utf8'),
    filename: file.filename,
    resolvedFileIsCurrent: upload.file === file,
  };
}

/** Terminal handler: answers every variable, reading each `Upload` (also inside an array). */
const echoUploads: RequestHandler = async (request, response, next) => {
  try {
    const variables = (request.body as { variables?: Record<string, unknown> } | undefined)?.variables ?? {};
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(variables)) {
      if (value instanceof Upload) {
        result[key] = await readUpload(value);
      } else if (Array.isArray(value)) {
        result[key] = await Promise.all(value.map((item) => (item instanceof Upload ? readUpload(item) : item)));
      } else {
        result[key] = value;
      }
    }
    response.json(result);
  } catch (error) {
    next(error);
  }
};

const errorAsJson: ErrorRequestHandler = (error, _request, response, _next) => {
  const status = error?.status ?? 500;
  response.status(status).json({ message: String(error?.message), status });
};

/** Starts an Express app with `/graphql` → upload middleware → echo handler. */
async function startServer(uploadMiddleware: RequestHandler): Promise<{ port: number; server: Server }> {
  const app = express();
  app.use('/graphql', uploadMiddleware, echoUploads);
  app.use(errorAsJson);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return { port: (server.address() as AddressInfo).port, server };
}

async function stopServer(server: Server | undefined): Promise<void> {
  if (!server) {
    return;
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Runs the child fixture to its end and reports how it ended. */
function runChild(mode: 'default' | 'framework'): Promise<{ code: null | number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    // `node --import tsx <file>` runs the fixture in this one process, so its exit code is the fixture's own.
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD_FIXTURE, mode], {
      cwd: ROOT,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`fixture did not end within 25 s. stdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 25_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });
}

/** Lists the temporary files fs-capacitor writes (`capacitor-<hex>.tmp`) in a directory. */
async function capacitorFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => /^capacitor-.*\.tmp$/.test(name));
}

/** Polls until the directory holds no capacitor file or the deadline passes; returns what is left. */
async function capacitorFilesAfterRelease(dir: string, deadlineMs = 3_000): Promise<string[]> {
  const until = Date.now() + deadlineMs;
  let left = await capacitorFiles(dir);
  while (left.length > 0 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    left = await capacitorFiles(dir);
  }
  return left;
}

describe('processGraphQlUploadRequest (GHSA-5vm7-vc2x-p3w2, GHSA-qwwm-252j-9whw)', () => {
  let server: Server | undefined;
  let port: number;

  beforeAll(async () => {
    ({ port, server } = await startServer(graphqlUploadExpress({ processRequest: processGraphQlUploadRequest })));
  });

  afterAll(async () => {
    await stopServer(server);
  });

  describe('map paths', () => {
    it("refuses the advisory's proof of concept (no file fields) with 400, and the server keeps answering", async () => {
      const refused = await postMultipart(port, '/graphql', graphQlMultipart(CRASH_OPERATIONS, CRASH_MAP));

      expect(refused.status).toBe(400);
      expect(JSON.parse(refused.body).message).toMatch(/^Invalid object path .*‘variables\.file\.reject’/);

      const next = await postMultipart(
        port,
        '/graphql',
        graphQlMultipart({ variables: { file: null } }, { '1': ['variables.file'] }, [{ content: 'after', name: '1' }]),
      );
      expect(next.status).toBe(200);
      expect(JSON.parse(next.body).file.content).toBe('after');
    });

    // The seven paths of the upstream fix (graphql-upload 18.0.2). Every file named in the map is sent.
    it.each([
      [
        'an upload method (variables.file.reject)',
        { file: null },
        { '1': ['variables.file'], '2': ['variables.file.reject'] },
      ],
      [
        "an upload's file (variables.file.file)",
        { file: null },
        { '1': ['variables.file'], '2': ['variables.file.file'] },
      ],
      ['an upload placed by the same entry', { file: null }, { '1': ['variables.file', 'variables.file.reject'] }],
      [
        "below an upload's direct child (variables.file.promise.then)",
        { file: null },
        { '1': ['variables.file'], '2': ['variables.file.promise.then'] },
      ],
      [
        'an upload in an array (variables.files.0.resolve)',
        { files: [null] },
        { '1': ['variables.files.0'], '2': ['variables.files.0.resolve'] },
      ],
      [
        'a __proto__ key forging an upload (variables.file.__proto__)',
        { file: { promise: { filename: true } } },
        { '1': ['variables.file.__proto__'] },
      ],
      [
        'a __proto__ key planting an inherited array element (variables.files.__proto__.0)',
        { files: [] },
        { '1': ['variables.files.__proto__.0'], '2': ['variables.files.0.reject'] },
      ],
    ])('refuses a path into %s with 400', async (_label, variables, map) => {
      const files = Object.keys(map).map((name) => ({ content: `file ${name}`, name }));

      const response = await postMultipart(port, '/graphql', graphQlMultipart({ variables }, map, files));

      expect(response.status, response.body).toBe(400);
      expect(JSON.parse(response.body).message).toMatch(/^Invalid object path /);
    });

    it('still lets a later map entry replace an upload at the same path', async () => {
      const response = await postMultipart(
        port,
        '/graphql',
        graphQlMultipart({ variables: { file: null } }, { '1': ['variables.file'], '2': ['variables.file'] }, [
          { content: 'one', name: '1' },
          { content: 'two', name: '2' },
        ]),
      );

      expect(response.status, response.body).toBe(200);
      expect(JSON.parse(response.body).file.content).toBe('two');
    });
  });

  describe('file fields', () => {
    let tmp: string;
    let previousTmpDir: string | undefined;

    beforeAll(async () => {
      // fs-capacitor writes its temporary files to `os.tmpdir()`, read when a file starts streaming. A directory of
      // this suite's own makes "nothing left behind" observable without counting anybody else's files.
      tmp = await mkdtemp(join(tmpdir(), 'lt-graphql-upload-'));
      previousTmpDir = process.env.TMPDIR;
      process.env.TMPDIR = tmp;
    });

    afterAll(async () => {
      if (previousTmpDir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmpDir;
      }
      await rm(tmp, { force: true, recursive: true });
    });

    afterEach(async () => {
      // A case that failed must not hand its leftovers to the next one.
      for (const name of await capacitorFiles(tmp)) {
        await rm(join(tmp, name), { force: true });
      }
    });

    it('delivers a single upload and releases its temporary file', async () => {
      const response = await postMultipart(
        port,
        '/graphql',
        graphQlMultipart({ variables: { file: null } }, { '1': ['variables.file'] }, [
          { content: 'hello', filename: 'hello.txt', name: '1' },
        ]),
      );

      expect(response.status, response.body).toBe(200);
      expect(JSON.parse(response.body).file).toEqual({
        content: 'hello',
        filename: 'hello.txt',
        resolvedFileIsCurrent: true,
      });
      expect(await capacitorFilesAfterRelease(tmp)).toEqual([]);
    });

    it('delivers one file referenced at two paths', async () => {
      const response = await postMultipart(
        port,
        '/graphql',
        graphQlMultipart({ variables: { a: null, b: null } }, { '1': ['variables.a', 'variables.b'] }, [
          { content: 'shared', name: '1' },
        ]),
      );

      expect(response.status, response.body).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.a.content).toBe('shared');
      expect(body.b.content).toBe('shared');
      expect(await capacitorFilesAfterRelease(tmp)).toEqual([]);
    });

    it('ignores a second file field with the name of a resolved upload and leaks no temporary file', async () => {
      const response = await postMultipart(
        port,
        '/graphql',
        graphQlMultipart({ variables: { file: null } }, { '1': ['variables.file'] }, [
          { content: 'first', filename: 'first.txt', name: '1' },
          { content: 'second', filename: 'second.txt', name: '1' },
        ]),
      );

      expect(response.status, response.body).toBe(200);
      // Unpatched, the duplicate resolved the upload again: `upload.file` became the second file (its promise stays on
      // the first), and only the second file's temporary file was released when the response closed.
      expect(JSON.parse(response.body).file).toEqual({
        content: 'first',
        filename: 'first.txt',
        resolvedFileIsCurrent: true,
      });
      expect(await capacitorFilesAfterRelease(tmp)).toEqual([]);
    });
  });
});

describe('the unpatched default against a real process', () => {
  it(
    "is crashed by the advisory's proof of concept — graphql-upload's own processRequest",
    { timeout: 30_000 },
    async () => {
      const { code, stderr, stdout } = await runChild('default');

      // Evidence that the defect is real and reachable through graphqlUploadExpress(), independent of the code: the
      // framework's diagnostics log the uncaught exception and exit 1.
      expect(stdout).not.toContain('ALIVE');
      expect(stderr).toContain('upload.reject is not a function');
      expect(code).toBe(1);
    },
  );

  it('answers 400 and keeps running with processGraphQlUploadRequest', { timeout: 30_000 }, async () => {
    const { code, stderr, stdout } = await runChild('framework');

    expect(stderr).not.toContain('uncaughtException');
    expect(stdout).toMatch(/^RESPONSE 400 Invalid object path /m);
    expect(stdout).toContain('ALIVE');
    expect(code).toBe(0);
  });
});

describe('CoreModule wiring', () => {
  let server: Server | undefined;

  afterAll(async () => {
    await stopServer(server);
  });

  it(
    'registers graphqlUploadExpress for the graphql route with processGraphQlUploadRequest',
    { timeout: 30_000 },
    async () => {
      // Imported here rather than at the top: the module graph behind CoreModule is large, and only this case needs it.
      const { CoreModule } = await import('../../src/core.module');

      const registered: Array<{ middleware: unknown[]; routes: unknown[] }> = [];
      const consumer = {
        apply: (...middleware: unknown[]) => ({
          forRoutes: (...routes: unknown[]) => {
            registered.push({ middleware, routes });
            return consumer;
          },
        }),
      } as unknown as MiddlewareConsumer;
      CoreModule.prototype.configure.call(Object.create(CoreModule.prototype), consumer);

      const upload = registered.find((entry) => entry.routes.includes('graphql'));
      expect(upload, 'CoreModule.configure() registers no middleware for the graphql route').toBeDefined();
      expect(upload.middleware).toHaveLength(1);

      let port: number;
      ({ port, server } = await startServer(upload.middleware[0] as RequestHandler));

      const refused = await postMultipart(port, '/graphql', graphQlMultipart(CRASH_OPERATIONS, CRASH_MAP));
      expect(refused.status, refused.body).toBe(400);
      expect(JSON.parse(refused.body).message).toMatch(/^Invalid object path /);

      const delivered = await postMultipart(
        port,
        '/graphql',
        graphQlMultipart({ variables: { file: null } }, { '1': ['variables.file'] }, [{ content: 'wired', name: '1' }]),
      );
      expect(delivered.status, delivered.body).toBe(200);
      expect(JSON.parse(delivered.body).file.content).toBe('wired');
    },
  );
});
