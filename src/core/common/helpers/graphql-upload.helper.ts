/**
 * GraphQL multipart request processing for `graphqlUploadExpress()`: graphql-upload's `processRequest` with the
 * fixes for GHSA-5vm7-vc2x-p3w2 (high) and GHSA-qwwm-252j-9whw (medium) applied.
 *
 * Source: package `graphql-upload` 17.1.0, file `processRequest.mjs`
 * (https://github.com/jaydenseric/graphql-upload), ported to TypeScript. Upstream fixed both advisories in
 * graphql-upload 18.0.2, which requires graphql 17 — this framework runs graphql 16 (Apollo Server 5,
 * @nestjs/graphql 14), so the fix is carried here instead. Both hunks of the upstream fix are applied unchanged:
 *
 * 1. GHSA-5vm7-vc2x-p3w2: a `map` path with a `__proto__` key, or one that goes through an already placed
 *    `Upload`, is refused with the existing 400 "Invalid object path". Without it one anonymous request crashed the
 *    process: `{"1":["variables.file"],"2":["variables.file.reject"]}` without file fields replaces the first
 *    upload's `reject`, and the parser's `finish` handler throws `TypeError: upload.reject is not a function` outside
 *    any request — an uncaught exception, which `installProcessDiagnostics()` (and Node itself) answers with exit 1.
 *    `variables.file.__proto__` gave a client-supplied object an `Upload` prototype, so it passed the scalar's
 *    `instanceof Upload` check.
 * 2. GHSA-qwwm-252j-9whw: a second file field with the name of an already resolved upload is ignored. Before, each
 *    duplicate created a new temporary file whose reference replaced the previous one, so only the last was released
 *    when the response closed — temporary files and file descriptors leaked per request (with `maxFiles` > 1; the
 *    default is unlimited).
 *
 * One addition of the framework's own, not in graphql-upload (18.0.2 has the same flaw): the `map` is bounded. A path
 * may have at most {@link GRAPHQL_UPLOAD_MAX_PATH_KEYS} keys, and the whole `map` at most
 * {@link GRAPHQL_UPLOAD_MAX_MAP_KEYS} entries and path keys together; over either bound the request is refused with
 * 400. object-path's `set()` recurses once per key and copies the remaining keys each time, so a path of n keys costs
 * O(n²) time and memory, all of it in one synchronous call: measured on Node 24, a single anonymous request with an
 * 80 KB path (40,000 keys) exhausted a 1 GB heap and ended the process; 16 KB (8,000 keys) took 300 MB and blocked the
 * event loop for half a second. Below the per-path bound, 1 MB of paths near it (the default `maxFieldSize`) still
 * blocked the event loop for 150 to 640 ms, and 1 MB of entries without any path (83,000 `Upload`s, each rejected with
 * an error of its own when its file never arrives) for 410 ms with 230 MB. With the map bound such requests are
 * refused within about 30 ms, most of it spent parsing the field's JSON.
 *
 * `CoreModule` passes this function to `graphqlUploadExpress({ processRequest })`. A project that registers
 * `graphqlUploadExpress()` itself must pass it too — graphql-upload's own default is the unpatched function.
 *
 * `Upload` comes from graphql-upload's own `Upload.mjs`, the class the `GraphQLUpload` scalar checks with
 * `instanceof`: an `Upload` of any other class would be refused as an invalid upload. `ignoreStream` is not exported
 * by graphql-upload and is re-implemented below.
 *
 * ---------------------------------------------------------------------------------------------------------------
 * MIT License
 *
 * Copyright Jayden Seric
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of
 * the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
 * THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * ---------------------------------------------------------------------------------------------------------------
 */
import busboy from 'busboy';
import { WriteStream } from 'fs-capacitor';
import Upload from 'graphql-upload/Upload.mjs';
import createError from 'http-errors';
import objectPath from 'object-path';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';

/** graphql-upload's `GRAPHQL_MULTIPART_REQUEST_SPEC_URL`, used in the error messages exactly as upstream does. */
const GRAPHQL_MULTIPART_REQUEST_SPEC_URL = 'https://github.com/jaydenseric/graphql-multipart-request-spec';

/**
 * Most keys one `map` path may have (`variables.input.files.3` has 4). A longer path is refused with 400 "Invalid
 * object path" before anything walks it: object-path's `set()` costs O(n²) in the number of keys. No request a client
 * library builds comes near it — batched operations add one key (`0.variables.file`).
 */
export const GRAPHQL_UPLOAD_MAX_PATH_KEYS = 64;

/**
 * Most entries and path keys one `map` may name together: every entry counts one, every key of its paths one more, so
 * `{"1":["variables.file"]}` counts 3, and 2,000 files at `variables.input.files.N` count 10,000. An entry over it is
 * refused before its `Upload` exists, with 400 "Invalid ‘map’ multipart field entry key …"; a path over it with 400
 * "Invalid object path". It bounds the work of a `map` of many paths that each stay under
 * {@link GRAPHQL_UPLOAD_MAX_PATH_KEYS} (1 MB of them blocked the event loop for up to 640 ms) and of a `map` of many
 * entries, each of which becomes an `Upload` that the parser rejects with an error of its own when its file never
 * arrives (1 MB of entries without a path, 83,000 of them, took 230 MB and blocked the event loop for 410 ms).
 */
export const GRAPHQL_UPLOAD_MAX_MAP_KEYS = 10_000;

/**
 * Options of {@link processGraphQlUploadRequest} — the same as graphql-upload's `ProcessRequestOptions`, so
 * `graphqlUploadExpress({ processRequest, ...options })` forwards them unchanged.
 */
export interface GraphQlUploadProcessRequestOptions {
  /** Maximum size of a non-file multipart field (`operations`, `map`) in bytes. Defaults to `1000000` (1 MB). */
  maxFieldSize?: number;
  /** Maximum size of one file in bytes. Defaults to `Infinity`. */
  maxFileSize?: number;
  /** Maximum number of files. Defaults to `Infinity`. */
  maxFiles?: number;
}

/** The GraphQL operation (or batch of operations) a multipart request resolves to, with `Upload` instances placed. */
export type GraphQlUploadOperations = Array<Record<string, unknown>> | Record<string, unknown>;

/** File details an `Upload` resolves with (graphql-upload's `FileUpload`). */
interface ProcessedFileUpload {
  capacitor: WriteStream;
  createReadStream: (options?: { encoding?: BufferEncoding; highWaterMark?: number }) => Readable;
  encoding: string;
  filename: string;
  mimetype: string;
}

/** An error created with `http-errors` (or any other error the parser reports). */
type ProcessRequestError = Error & { expose?: boolean; status?: number };

/**
 * Safely ignores a readable stream (graphql-upload's `ignoreStream`, which the package does not export): an error
 * on it must not crash the process, and its data is drained so the parser can go on.
 */
function ignoreStream(stream: Readable): void {
  // Prevent an unhandled error from crashing the process.
  stream.on('error', () => {});

  // Waste the stream.
  stream.resume();
}

/**
 * Processes an incoming GraphQL multipart request
 * (https://github.com/jaydenseric/graphql-multipart-request-spec): parses the `operations` and `map` fields, places
 * an `Upload` wherever the `map` names one and resolves each with its file once that file streams in.
 *
 * graphql-upload 17.1.0's `processRequest` with the fixes of graphql-upload 18.0.2 (see the file header). Pass it to
 * `graphqlUploadExpress({ processRequest: processGraphQlUploadRequest })`; `CoreModule` does so for `/graphql`.
 *
 * @returns The operation(s), with an `Upload` at every mapped path — resolved once the `map` is parsed. Rejects with
 *   an `http-errors` error (400 for a malformed request, 413 above a limit, 499 on a disconnect).
 */
export function processGraphQlUploadRequest(
  request: IncomingMessage,
  response: ServerResponse,
  { maxFieldSize = 1000000, maxFileSize = Infinity, maxFiles = Infinity }: GraphQlUploadProcessRequestOptions = {},
): Promise<GraphQlUploadOperations> {
  return new Promise((resolve, reject) => {
    let released: boolean;
    let exitError: ProcessRequestError;
    let operations: GraphQlUploadOperations;
    let operationsPath: ReturnType<typeof objectPath>;
    let map: Map<string, Upload>;

    const parser = busboy({
      headers: request.headers,
      defParamCharset: 'utf8',
      limits: {
        fieldSize: maxFieldSize,
        fields: 2, // Only operations and map.
        fileSize: maxFileSize,
        files: maxFiles,
      },
    });

    /**
     * Exits request processing with an error. Successive calls have no effect.
     */
    function exit(error: ProcessRequestError, isParserError = false): void {
      if (exitError) {
        return;
      }

      exitError = error;

      if (map) {
        for (const upload of map.values()) {
          if (!upload.file) {
            upload.reject(exitError);
          }
        }
      }

      // If the error came from the parser, don't cause it to be emitted again.
      if (isParserError) {
        parser.destroy();
      } else {
        parser.destroy(exitError);
      }

      request.unpipe(parser);

      // With a sufficiently large request body, subsequent events in the same event frame cause the stream to pause
      // after the parser is destroyed. To ensure that the request resumes, the call to .resume() is scheduled for
      // later in the event loop.
      setImmediate(() => {
        request.resume();
      });

      reject(exitError);
    }

    parser.on('field', (fieldName: string, value: string, { valueTruncated }: { valueTruncated: boolean }) => {
      if (valueTruncated) {
        return exit(
          createError(413, `The ‘${fieldName}’ multipart field value exceeds the ${maxFieldSize} byte size limit.`),
        );
      }

      switch (fieldName) {
        case 'operations':
          try {
            operations = JSON.parse(value);
          } catch {
            return exit(
              createError(
                400,
                `Invalid JSON in the ‘operations’ multipart field (${GRAPHQL_MULTIPART_REQUEST_SPEC_URL}).`,
              ),
            );
          }

          // `operations` should be an object or an array. Note that arrays and `null` have an `object` type.
          if (typeof operations !== 'object' || !operations) {
            return exit(
              createError(
                400,
                `Invalid type for the ‘operations’ multipart field (${GRAPHQL_MULTIPART_REQUEST_SPEC_URL}).`,
              ),
            );
          }

          operationsPath = objectPath(operations);

          break;
        case 'map': {
          if (!operations) {
            return exit(
              createError(
                400,
                `Misordered multipart fields; ‘map’ should follow ‘operations’ (${GRAPHQL_MULTIPART_REQUEST_SPEC_URL}).`,
              ),
            );
          }

          let parsedMap: unknown;
          try {
            parsedMap = JSON.parse(value);
          } catch {
            return exit(
              createError(400, `Invalid JSON in the ‘map’ multipart field (${GRAPHQL_MULTIPART_REQUEST_SPEC_URL}).`),
            );
          }

          // `map` should be an object.
          if (typeof parsedMap !== 'object' || !parsedMap || Array.isArray(parsedMap)) {
            return exit(
              createError(400, `Invalid type for the ‘map’ multipart field (${GRAPHQL_MULTIPART_REQUEST_SPEC_URL}).`),
            );
          }

          const mapEntries = Object.entries(parsedMap);

          // Check max files is not exceeded, even though the number of files to parse might not match the map
          // provided by the client.
          if (mapEntries.length > maxFiles) {
            return exit(createError(413, `${maxFiles} max file uploads exceeded.`));
          }

          map = new Map();
          // Map entries and path keys so far, against GRAPHQL_UPLOAD_MAX_MAP_KEYS.
          let mapKeyCount = 0;
          for (const [mapFieldName, paths] of mapEntries) {
            if (!Array.isArray(paths)) {
              return exit(
                createError(
                  400,
                  `Invalid type for the ‘map’ multipart field entry key ‘${mapFieldName}’ array (${GRAPHQL_MULTIPART_REQUEST_SPEC_URL}).`,
                ),
              );
            }

            // Every entry counts one against GRAPHQL_UPLOAD_MAX_MAP_KEYS, before its Upload exists: an Upload whose
            // file never arrives is rejected with an error of its own at the end of the request.
            mapKeyCount += 1;
            if (mapKeyCount > GRAPHQL_UPLOAD_MAX_MAP_KEYS) {
              return exit(
                createError(
                  400,
                  `Invalid ‘map’ multipart field entry key ‘${mapFieldName}’: the map has more than ${GRAPHQL_UPLOAD_MAX_MAP_KEYS} entries and object path keys together (${GRAPHQL_MULTIPART_REQUEST_SPEC_URL}).`,
                ),
              );
            }

            map.set(mapFieldName, new Upload());

            for (const [index, path] of paths.entries()) {
              if (typeof path !== 'string') {
                return exit(
                  createError(
                    400,
                    `Invalid type for the ‘map’ multipart field entry key ‘${mapFieldName}’ array index ‘${index}’ value (${GRAPHQL_MULTIPART_REQUEST_SPEC_URL}).`,
                  ),
                );
              }

              try {
                // GHSA-5vm7-vc2x-p3w2 (graphql-upload 18.0.2): check the upload's mapped path in the operations is
                // safe before setting it.
                const keys = path.split('.');

                // Bound the path, and the whole map, before anything walks it: object-path's `set()` recurses once per
                // key with a copy of the remaining keys — O(n²) for a path of n keys (see the file header).
                if (keys.length > GRAPHQL_UPLOAD_MAX_PATH_KEYS) {
                  throw new RangeError(`Object path has more than ${GRAPHQL_UPLOAD_MAX_PATH_KEYS} keys.`);
                }
                mapKeyCount += keys.length;
                if (mapKeyCount > GRAPHQL_UPLOAD_MAX_MAP_KEYS) {
                  throw new RangeError(
                    `The map has more than ${GRAPHQL_UPLOAD_MAX_MAP_KEYS} entries and object path keys.`,
                  );
                }

                let pathValue: unknown = operations;

                for (const [keyIndex, key] of keys.entries()) {
                  // Forbid `__proto__` keys to prevent prototype manipulation that could make client-supplied
                  // objects pass `instanceof Upload` checks.
                  if (key === '__proto__') {
                    throw new TypeError('Object path has a `__proto__` key.');
                  }

                  // Forbid setting an upload within an already set upload, but allow a total replacement. Resolved
                  // with object-path's own `get`, so it sees what `set` will reach, inherited array elements included.
                  if (keyIndex < keys.length - 1) {
                    pathValue = objectPath.get(pathValue as object, [key]);

                    if (pathValue instanceof Upload) {
                      throw new TypeError('Object path traverses an upload.');
                    }
                  }
                }

                operationsPath.set(path, map.get(mapFieldName));
              } catch {
                return exit(
                  createError(
                    400,
                    `Invalid object path for the ‘map’ multipart field entry key ‘${mapFieldName}’ array index ‘${index}’ value ‘${path}’ (${GRAPHQL_MULTIPART_REQUEST_SPEC_URL}).`,
                  ),
                );
              }
            }
          }

          resolve(operations);
        }
      }
    });

    parser.on(
      'file',
      (
        fieldName: string,
        stream: Readable,
        { encoding, filename, mimeType: mimetype }: { encoding: string; filename: string; mimeType: string },
      ) => {
        if (!map) {
          ignoreStream(stream);
          return exit(
            createError(
              400,
              `Misordered multipart fields; files should follow ‘map’ (${GRAPHQL_MULTIPART_REQUEST_SPEC_URL}).`,
            ),
          );
        }

        const upload = map.get(fieldName);

        // GHSA-qwwm-252j-9whw (graphql-upload 18.0.2): `|| upload.file` — a duplicate file field would create a new
        // capacitor and replace the reference to the first one, which then never gets released.
        if (!upload || upload.file) {
          // The file is extraneous or a duplicate. As the rest can still be processed, just ignore it and don't
          // exit with an error.
          ignoreStream(stream);
          return;
        }

        let fileError: ProcessRequestError;

        const capacitor = new WriteStream();

        capacitor.on('error', () => {
          stream.unpipe();
          stream.resume();
        });

        stream.on('limit', () => {
          fileError = createError(413, `File truncated as it exceeds the ${maxFileSize} byte size limit.`);
          stream.unpipe();
          capacitor.destroy(fileError);
        });

        stream.on('error', (error: Error) => {
          fileError = error;
          stream.unpipe();
          capacitor.destroy(fileError);
        });

        const file: ProcessedFileUpload = {
          filename,
          mimetype,
          encoding,
          createReadStream(options) {
            const error = fileError || (released ? exitError : null);
            if (error) {
              throw error;
            }
            return capacitor.createReadStream(options);
          },
          capacitor,
        };

        Object.defineProperty(file, 'capacitor', {
          enumerable: false,
          configurable: false,
          writable: false,
        });

        stream.pipe(capacitor);
        upload.resolve(file);
      },
    );

    parser.once('filesLimit', () => exit(createError(413, `${maxFiles} max file uploads exceeded.`)));

    parser.once('finish', () => {
      request.unpipe(parser);
      request.resume();

      if (!operations) {
        return exit(createError(400, `Missing multipart field ‘operations’ (${GRAPHQL_MULTIPART_REQUEST_SPEC_URL}).`));
      }

      if (!map) {
        return exit(createError(400, `Missing multipart field ‘map’ (${GRAPHQL_MULTIPART_REQUEST_SPEC_URL}).`));
      }

      for (const upload of map.values()) {
        if (!upload.file) {
          upload.reject(createError(400, 'File missing in the request.'));
        }
      }
    });

    // Use the `on` method instead of `once` as in edge cases the same parser could have multiple `error` events and
    // all must be handled to prevent the Node.js process exiting with an error. One edge case is if there is a
    // malformed part header as well as an unexpected end of the form.
    parser.on('error', (error: Error) => {
      exit(error, true);
    });

    response.once('close', () => {
      released = true;

      if (map) {
        for (const upload of map.values()) {
          if (upload.file) {
            // Release resources and clean up temporary files.
            (upload.file as ProcessedFileUpload).capacitor.release();
          }
        }
      }
    });

    request.once('close', () => {
      if (!request.readableEnded) {
        exit(createError(499, 'Request disconnected during file upload stream parsing.'));
      }
    });

    request.pipe(parser);
  });
}
