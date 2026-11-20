/**
 * Raw GraphQL multipart requests (https://github.com/jaydenseric/graphql-multipart-request-spec) for the upload
 * tests: the body is written byte for byte here, so a case can send what no well-behaved client library would — a
 * `map` without its file fields, the same file field twice, a path with a `__proto__` key.
 *
 * Used by `tests/unit/graphql-upload-process-request.spec.ts`, its child fixtures
 * (`tests/unit/fixtures/graphql-upload-crash-child.ts`, `tests/unit/fixtures/graphql-upload-deep-path-child.ts`) and
 * `tests/file.e2e-spec.ts`.
 */
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';

/** One multipart part: a plain field, or a file field with a file name and its content. */
export type MultipartPart = { content: string; filename: string; name: string } | { name: string; value: string };

/** A multipart body and the `Content-Type` header (with its boundary) that goes with it. */
export interface MultipartBody {
  body: Buffer;
  contentType: string;
}

/** Status and body of a response, or the error the request ended with (a reset socket, a closed server). */
export interface MultipartResponse {
  body: string;
  status: number;
}

/**
 * The map of GHSA-5vm7-vc2x-p3w2's proof of concept: upload 2 is placed INTO upload 1 and replaces its `reject`. Sent
 * without file fields, graphql-upload < 18.0.2 calls `upload.reject()` in the parser's `finish` handler and throws
 * `TypeError: upload.reject is not a function` outside any request — an uncaught exception.
 */
export const CRASH_MAP = { '1': ['variables.file'], '2': ['variables.file.reject'] };

/** The `operations` of the proof of concept. */
export const CRASH_OPERATIONS = { query: '{ __typename }', variables: { file: null } };

/**
 * Builds a multipart body from the parts, in the order given.
 */
export function buildMultipart(parts: MultipartPart[]): MultipartBody {
  const boundary = `----lt-graphql-upload-${randomUUID()}`;
  const chunks: string[] = [];
  for (const part of parts) {
    chunks.push(`--${boundary}\r\n`);
    if ('filename' in part) {
      chunks.push(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
          'Content-Type: text/plain\r\n\r\n' +
          `${part.content}\r\n`,
      );
    } else {
      chunks.push(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`);
    }
  }
  chunks.push(`--${boundary}--\r\n`);
  return { body: Buffer.from(chunks.join(''), 'utf8'), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * The parts of a GraphQL multipart request: `operations`, `map`, then the files.
 */
export function graphQlMultipart(
  operations: unknown,
  map: Record<string, string[]>,
  files: Array<{ content: string; filename?: string; name: string }> = [],
): MultipartBody {
  return buildMultipart([
    { name: 'operations', value: JSON.stringify(operations) },
    { name: 'map', value: JSON.stringify(map) },
    ...files.map((file) => ({ content: file.content, filename: file.filename ?? `${file.name}.txt`, name: file.name })),
  ]);
}

/**
 * POSTs a multipart body to `http://127.0.0.1:<port><path>` and resolves with status and body. A new connection per
 * request (`agent: false`), so a socket the server dropped cannot be reused by the next request.
 */
export function postMultipart(
  port: number,
  path: string,
  { body, contentType }: MultipartBody,
  headers: Record<string, string> = {},
): Promise<MultipartResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        agent: false,
        headers: { ...headers, 'content-length': String(body.length), 'content-type': contentType },
        host: '127.0.0.1',
        method: 'POST',
        path,
        port,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), status: res.statusCode ?? 0 }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
