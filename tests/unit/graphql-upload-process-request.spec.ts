import express from 'express';
import graphqlUploadExpress from 'graphql-upload/graphqlUploadExpress.mjs';
import Upload from 'graphql-upload/Upload.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  GRAPHQL_UPLOAD_MAX_PATH_KEYS,
  GRAPHQL_UPLOAD_MAX_MAP_KEYS,
  processGraphQlUploadRequest,
} from '../../src/core/common/helpers/graphql-upload.helper';
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
const DEEP_PATH_CHILD_FIXTURE = join(__dirname, 'fixtures', 'graphql-upload-deep-path-child.ts');
const SPARSE_ARRAY_CHILD_FIXTURE = join(__dirname, 'fixtures', 'graphql-upload-sparse-array-child.ts');

/**
 * The largest array index there is: object-path reads it as a number and sets it, so the array it creates has
 * 4,294,967,295 elements, every one but the last a hole.
 */
const SPARSE_INDEX = '4294967294';

/**
 * Keys of the deep path the heap-limited child sends. Far over GRAPHQL_UPLOAD_MAX_PATH_KEYS and, with its one map
 * entry, still under GRAPHQL_UPLOAD_MAX_MAP_KEYS, so only the per-path bound stands between it and object-path's O(n²)
 * `set()`:
 * unbounded, reaching depth ~1,500 of 9,000 already holds ~100 MB of key copies, and the child's heap is 128 MB.
 */
const DEEP_PATH_KEYS = 9_000;
const CONSTRAINED_HEAP = ['--max-old-space-size=128'];

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

/** Echoes a variable value, reading each `Upload` in it (also inside an array or a nested object). */
async function echoValue(value: unknown): Promise<unknown> {
  if (value instanceof Upload) {
    return readUpload(value);
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => echoValue(item)));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = await echoValue(item);
    }
    return result;
  }
  return value;
}

/** Terminal handler: answers every variable, reading each `Upload` (also inside an array or a nested object). */
const echoUploads: RequestHandler = async (request, response, next) => {
  try {
    const variables = (request.body as { variables?: Record<string, unknown> } | undefined)?.variables ?? {};
    response.json(await echoValue(variables));
  } catch (error) {
    next(error);
  }
};

/** A `map` path of exactly `count` keys below `variables`: `variables.<leaf>` for 2, `variables.a.<leaf>` for 3, … */
function pathOfKeys(count: number, leaf = 'a'): string {
  return ['variables', ...Array<string>(count - 2).fill('a'), leaf].join('.');
}

/** Follows `steps` times the `a` property, as {@link pathOfKeys} nests it. */
function followA(value: unknown, steps: number): unknown {
  let node = value;
  for (let step = 0; step < steps; step++) {
    node = (node as Record<string, unknown>).a;
  }
  return node;
}

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

/** How a child fixture ended. */
interface ChildOutcome {
  code: null | number;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

/** Runs a child fixture to its end and reports how it ended. */
function runChild(
  mode: 'default' | 'framework',
  {
    args = [],
    fixture = CHILD_FIXTURE,
    nodeArgs = [],
  }: { args?: string[]; fixture?: string; nodeArgs?: string[] } = {},
): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    // `node --import tsx <file>` runs the fixture in this one process, so its exit code is the fixture's own.
    const child = spawn(process.execPath, [...nodeArgs, '--import', 'tsx', fixture, mode, ...args], {
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
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout });
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

  /**
   * @regression   12.10.1 — processGraphQlUploadRequest() bounded neither how many keys a `map` path has nor how
   *   large the whole `map` is. object-path's `set()` recurses once per key with a copy of the remaining keys, so one
   *   anonymous request with an 80 KB path (40,000 keys) exhausted a 1 GB heap; 1 MB of 64-key paths blocked the event
   *   loop for up to 640 ms; 1 MB of entries without a path (83,000 Uploads, each rejected with an error of its own)
   *   took 230 MB and 410 ms. And object-path reads a key like `4294967294` as a number: `variables.f.4294967294`
   *   (258 bytes) became an array of 2^32 − 1 elements, whose holes GraphQL's list coercion in the complexity plugin
   *   walked until a 1 GB heap ran out. graphql-upload 18.0.2 has the same flaws.
   * @seen-failing Registered in tests/regression-mutations.json: `graphql-upload-map-path-depth-unbounded` (the
   *   per-path bound gone: the over-the-bound case answers 200, and the heap-limited child below dies of heap
   *   exhaustion instead of answering 400), `graphql-upload-map-path-total-unbounded` (path keys no longer checked
   *   against the map bound: the one-path-key-over case answers 200), `graphql-upload-map-entries-uncounted`
   *   (entries no longer counted: the path-less-entries and the entries-plus-keys cases answer 200) and
   *   `graphql-upload-map-array-holes-uncounted` (array elements no longer counted: the 4294967294, index-at-the-bound
   *   and moderate-indices cases answer 200, and the heap-limited sparse-array child dies of heap exhaustion).
   */
  describe('map size (GRAPHQL_UPLOAD_MAX_PATH_KEYS, GRAPHQL_UPLOAD_MAX_MAP_KEYS)', () => {
    it('refuses a path with one key more than the bound with 400, and the server keeps answering', async () => {
      const path = pathOfKeys(GRAPHQL_UPLOAD_MAX_PATH_KEYS + 1);
      expect(path.split('.')).toHaveLength(GRAPHQL_UPLOAD_MAX_PATH_KEYS + 1);

      const refused = await postMultipart(
        port,
        '/graphql',
        graphQlMultipart({ variables: {} }, { '1': [path] }, [{ content: 'deep', name: '1' }]),
      );

      expect(refused.status, refused.body).toBe(400);
      expect(JSON.parse(refused.body).message).toMatch(/^Invalid object path /);

      const next = await postMultipart(
        port,
        '/graphql',
        graphQlMultipart({ variables: { file: null } }, { '1': ['variables.file'] }, [{ content: 'after', name: '1' }]),
      );
      expect(next.status, next.body).toBe(200);
      expect(JSON.parse(next.body).file.content).toBe('after');
    });

    it('accepts a path with exactly the bound of keys and delivers its file there', async () => {
      const path = pathOfKeys(GRAPHQL_UPLOAD_MAX_PATH_KEYS, 'file');
      expect(path.split('.')).toHaveLength(GRAPHQL_UPLOAD_MAX_PATH_KEYS);

      const response = await postMultipart(
        port,
        '/graphql',
        graphQlMultipart({ variables: {} }, { '1': [path] }, [{ content: 'deep', filename: 'deep.txt', name: '1' }]),
      );

      expect(response.status, response.body).toBe(200);
      const leaf = followA(JSON.parse(response.body), GRAPHQL_UPLOAD_MAX_PATH_KEYS - 2) as Record<string, unknown>;
      expect(leaf.file).toEqual({ content: 'deep', filename: 'deep.txt', resolvedFileIsCurrent: true });
    });

    it('accepts a map at exactly the bound, and refuses one path key more with 400 "Invalid object path"', async () => {
      // One map entry (1) with paths of 33 keys, each at its own variable: exactly GRAPHQL_UPLOAD_MAX_MAP_KEYS.
      const keysPerPath = 33;
      const count = (GRAPHQL_UPLOAD_MAX_MAP_KEYS - 1) / keysPerPath;
      expect(Number.isInteger(count)).toBe(true);
      const paths = Array.from({ length: count }, (_, index) =>
        ['variables', `f${index}`, ...Array<string>(keysPerPath - 2).fill('a')].join('.'),
      );
      const file = [{ content: 'shared', name: '1' }];

      const accepted = await postMultipart(port, '/graphql', graphQlMultipart({ variables: {} }, { '1': paths }, file));
      expect(accepted.status, accepted.body.slice(0, 300)).toBe(200);
      const body = JSON.parse(accepted.body) as Record<string, unknown>;
      expect(Object.keys(body)).toHaveLength(count);
      expect(followA(body[`f${count - 1}`], keysPerPath - 2)).toMatchObject({ content: 'shared' });

      // One more path of two keys in the same entry: the map goes over the bound at that path.
      const refused = await postMultipart(
        port,
        '/graphql',
        graphQlMultipart({ variables: {} }, { '1': [...paths, 'variables.extra'] }, file),
      );
      expect(refused.status, refused.body.slice(0, 300)).toBe(400);
      expect(JSON.parse(refused.body).message).toMatch(/^Invalid object path .*‘variables\.extra’/);
    });

    it('refuses one path-less map entry more than the bound with 400, and the server keeps answering', async () => {
      // Entries without any path: no key at all, but each one becomes an Upload that is rejected at the end of the
      // request. The entry over the bound is refused before its Upload exists.
      const map: Record<string, string[]> = {};
      for (let index = 0; index <= GRAPHQL_UPLOAD_MAX_MAP_KEYS; index++) {
        map[`e${index}`] = [];
      }

      const refused = await postMultipart(port, '/graphql', graphQlMultipart({ variables: {} }, map));

      expect(refused.status, refused.body.slice(0, 300)).toBe(400);
      expect(JSON.parse(refused.body).message).toMatch(
        new RegExp(`^Invalid ‘map’ multipart field entry key ‘e${GRAPHQL_UPLOAD_MAX_MAP_KEYS}’`),
      );

      const next = await postMultipart(
        port,
        '/graphql',
        graphQlMultipart({ variables: { file: null } }, { '1': ['variables.file'] }, [{ content: 'after', name: '1' }]),
      );
      expect(next.status, next.body).toBe(200);
      expect(JSON.parse(next.body).file.content).toBe('after');
    });

    it('accepts exactly the bound of path-less map entries', async () => {
      const map: Record<string, string[]> = {};
      for (let index = 0; index < GRAPHQL_UPLOAD_MAX_MAP_KEYS; index++) {
        map[`e${index}`] = [];
      }

      const accepted = await postMultipart(port, '/graphql', graphQlMultipart({ variables: {} }, map));

      expect(accepted.status, accepted.body.slice(0, 300)).toBe(200);
    });

    it('counts map entries and path keys together', async () => {
      // Entries of one 3-key path each, outside `variables` (which the echo handler reads, so no file has to be sent):
      // every entry costs 4. Neither the entries nor the path keys alone come near the bound — only their sum does.
      const keysPerPath = 3;
      const count = GRAPHQL_UPLOAD_MAX_MAP_KEYS / (1 + keysPerPath);
      expect(Number.isInteger(count)).toBe(true);
      expect(count * keysPerPath).toBeLessThan(GRAPHQL_UPLOAD_MAX_MAP_KEYS);
      const entries = (total: number): Record<string, string[]> => {
        const map: Record<string, string[]> = {};
        for (let index = 0; index < total; index++) {
          map[String(index)] = [`extensions.f${index}.file`];
        }
        return map;
      };
      const operations = { extensions: {}, variables: {} };

      const accepted = await postMultipart(port, '/graphql', graphQlMultipart(operations, entries(count)));
      expect(accepted.status, accepted.body.slice(0, 300)).toBe(200);

      // One entry more: refused at that entry, before its Upload exists.
      const refused = await postMultipart(port, '/graphql', graphQlMultipart(operations, entries(count + 1)));
      expect(refused.status, refused.body.slice(0, 300)).toBe(400);
      expect(JSON.parse(refused.body).message).toMatch(
        new RegExp(`^Invalid ‘map’ multipart field entry key ‘${count}’`),
      );
    });

    it('refuses a numeric key that would make an array of 2^32 − 1 elements with 400, and the server keeps answering', async () => {
      // Outside `variables`, which the echo handler reads: an unbounded parser answers 200 here at once instead of the
      // handler walking the holes.
      const path = `extensions.f.${SPARSE_INDEX}`;

      const refused = await postMultipart(port, '/graphql', graphQlMultipart({ variables: {} }, { '1': [path] }));

      expect(refused.status, refused.body.slice(0, 300)).toBe(400);
      expect(JSON.parse(refused.body).message).toMatch(/^Invalid object path .*‘extensions\.f\.4294967294’/);

      const next = await postMultipart(
        port,
        '/graphql',
        graphQlMultipart({ variables: { file: null } }, { '1': ['variables.file'] }, [{ content: 'after', name: '1' }]),
      );
      expect(next.status, next.body).toBe(200);
      expect(JSON.parse(next.body).file.content).toBe('after');
    });

    it('counts every element a numeric key adds, holes included, up to the bound', async () => {
      // One entry (1), three path keys (3) and index + 1 new elements: an index of the bound − 5 fills it exactly.
      const atBound = GRAPHQL_UPLOAD_MAX_MAP_KEYS - 5;

      const accepted = await postMultipart(
        port,
        '/graphql',
        graphQlMultipart({ variables: {} }, { '1': [`extensions.f.${atBound}`] }),
      );
      expect(accepted.status, accepted.body.slice(0, 300)).toBe(200);

      const refused = await postMultipart(
        port,
        '/graphql',
        graphQlMultipart({ variables: {} }, { '1': [`extensions.f.${atBound + 1}`] }),
      );
      expect(refused.status, refused.body.slice(0, 300)).toBe(400);
      expect(JSON.parse(refused.body).message).toMatch(/^Invalid object path /);
    });

    it('counts array growth across entries: moderate indices in distinct arrays that together exceed the bound', async () => {
      // Each entry sets index 999 of an array of its own: 1 + 3 + 1,000 units, far under the bound on its own.
      const elements = 1_000;
      const perEntry = 1 + 3 + elements;
      const count = Math.floor(GRAPHQL_UPLOAD_MAX_MAP_KEYS / perEntry);
      const entries = (total: number): Record<string, string[]> => {
        const map: Record<string, string[]> = {};
        for (let index = 0; index < total; index++) {
          map[String(index)] = [`extensions.f${index}.${elements - 1}`];
        }
        return map;
      };

      const accepted = await postMultipart(port, '/graphql', graphQlMultipart({ variables: {} }, entries(count)));
      expect(accepted.status, accepted.body.slice(0, 300)).toBe(200);

      const refused = await postMultipart(port, '/graphql', graphQlMultipart({ variables: {} }, entries(count + 1)));
      expect(refused.status, refused.body.slice(0, 300)).toBe(400);
      expect(JSON.parse(refused.body).message).toMatch(
        new RegExp(`^Invalid object path .*‘extensions\\.f${count}\\.${elements - 1}’`),
      );
    });

    it('accepts files at variables.files.0 … n and delivers each at its index', async () => {
      const count = 20;
      const map: Record<string, string[]> = {};
      const files: Array<{ content: string; name: string }> = [];
      for (let index = 0; index < count; index++) {
        map[String(index)] = [`variables.files.${index}`];
        files.push({ content: `file ${index}`, name: String(index) });
      }

      const response = await postMultipart(port, '/graphql', graphQlMultipart({ variables: {} }, map, files));

      expect(response.status, response.body.slice(0, 300)).toBe(200);
      const delivered = (JSON.parse(response.body).files as Array<{ content: string }>).map((file) => file.content);
      expect(delivered).toEqual(files.map((file) => file.content));
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

  it('premise: the deep path stays under the map bound, so only the per-path bound refuses it', () => {
    expect(DEEP_PATH_KEYS).toBeGreaterThan(GRAPHQL_UPLOAD_MAX_PATH_KEYS);
    // One map entry plus the path's keys.
    expect(1 + DEEP_PATH_KEYS).toBeLessThanOrEqual(GRAPHQL_UPLOAD_MAX_MAP_KEYS);
  });

  it(
    `runs out of a 128 MB heap on one ${DEEP_PATH_KEYS}-key map path — graphql-upload's own processRequest`,
    { timeout: 30_000 },
    async () => {
      const { code, signal, stderr, stdout } = await runChild('default', {
        args: [String(DEEP_PATH_KEYS)],
        fixture: DEEP_PATH_CHILD_FIXTURE,
        nodeArgs: CONSTRAINED_HEAP,
      });

      // Evidence that the unbounded path ends a process, independent of the code: V8 aborts on heap exhaustion.
      expect(stdout).not.toContain('ALIVE');
      expect(stderr).toMatch(/heap out of memory/i);
      expect(code === 0 && signal === null).toBe(false);
    },
  );

  it(
    `answers the same ${DEEP_PATH_KEYS}-key path with 400 in a 128 MB heap and keeps running with processGraphQlUploadRequest`,
    { timeout: 30_000 },
    async () => {
      const { code, stderr, stdout } = await runChild('framework', {
        args: [String(DEEP_PATH_KEYS)],
        fixture: DEEP_PATH_CHILD_FIXTURE,
        nodeArgs: CONSTRAINED_HEAP,
      });

      expect(stderr).not.toMatch(/heap out of memory/i);
      expect(stdout).toMatch(/^RESPONSE 400 Invalid object path /m);
      expect(stdout).toMatch(/^NEXT 200 /m);
      expect(stdout).toContain('ALIVE');
      expect(code).toBe(0);
    },
  );

  it(
    `runs out of a 128 MB heap in ComplexityPlugin on map index ${SPARSE_INDEX} — graphql-upload's own processRequest`,
    { timeout: 30_000 },
    async () => {
      const { code, signal, stderr, stdout } = await runChild('default', {
        args: [SPARSE_INDEX],
        fixture: SPARSE_ARRAY_CHILD_FIXTURE,
        nodeArgs: CONSTRAINED_HEAP,
      });

      // Evidence that the sparse array ends a process through the real plugin and schema, independent of the code.
      expect(stdout).not.toContain('ALIVE');
      expect(stderr).toMatch(/heap out of memory/i);
      expect(code === 0 && signal === null).toBe(false);
    },
  );

  it(
    `answers map index ${SPARSE_INDEX} with 400 in a 128 MB heap, and the next upload passes ComplexityPlugin`,
    { timeout: 30_000 },
    async () => {
      const { code, stderr, stdout } = await runChild('framework', {
        args: [SPARSE_INDEX],
        fixture: SPARSE_ARRAY_CHILD_FIXTURE,
        nodeArgs: CONSTRAINED_HEAP,
      });

      expect(stderr).not.toMatch(/heap out of memory/i);
      expect(stdout).toMatch(/^RESPONSE 400 Invalid object path /m);
      expect(stdout).toMatch(/^NEXT 200 OK/m);
      expect(stdout).toContain('ALIVE');
      expect(code).toBe(0);
    },
  );
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
