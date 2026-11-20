/**
 * Child fixture for `../graphql-upload-process-request.spec.ts`: an Express server with graphql-upload's
 * `graphqlUploadExpress()` and the framework's REAL process diagnostics (`installProcessDiagnostics()`), which sends
 * itself ONE multipart request whose `map` holds a single path of `argv[3]` keys (`variables.a.a.a…`). The spec starts
 * it with a constrained heap (`--max-old-space-size=128`).
 *
 * object-path's `set()` recurses once per key with a copy of the remaining keys, so an unbounded path of n keys costs
 * O(n²) memory in one synchronous call: V8 aborts on heap exhaustion before the request is answered.
 *
 * `argv[2]`: `default` uses graphql-upload's own `processRequest`, `framework` the framework's
 * `processGraphQlUploadRequest`. Prints `RESPONSE <status> <body start>`, then `NEXT <status>` for an ordinary upload
 * sent afterwards, then `ALIVE`, and exits 0.
 *
 * Not a `*.spec.ts`, so neither vitest runner picks it up as a suite.
 */
import express from 'express';
import graphqlUploadExpress from 'graphql-upload/graphqlUploadExpress.mjs';

import { processGraphQlUploadRequest } from '../../../src/core/common/helpers/graphql-upload.helper';
import { installProcessDiagnostics } from '../../../src/core/common/helpers/process-diagnostics.helper';
import { graphQlMultipart, postMultipart } from '../../helpers/graphql-multipart';

import type { ErrorRequestHandler } from 'express';
import type { AddressInfo } from 'node:net';

installProcessDiagnostics();

const mode = process.argv[2];
const keys = Number(process.argv[3]);
if ((mode !== 'default' && mode !== 'framework') || !Number.isInteger(keys) || keys < 2) {
  process.stderr.write(`usage: <default|framework> <keys ≥ 2>, got '${mode}' '${process.argv[3]}'\n`);
  process.exit(2);
}

const errorAsText: ErrorRequestHandler = (error, _request, response, _next) => {
  response.status(error?.status ?? 500).send(String(error?.message));
};

const app = express();
app.use(
  '/graphql',
  graphqlUploadExpress(mode === 'framework' ? { processRequest: processGraphQlUploadRequest } : {}),
  (_request, response) => {
    response.send('OK');
  },
);
app.use(errorAsText);

const server = app.listen(0, '127.0.0.1', () => {
  void run();
});

/** Sends one request and describes its outcome as `<status> <body start>`. */
async function send(port: number, map: Record<string, string[]>, operations: unknown): Promise<string> {
  try {
    const response = await postMultipart(
      port,
      '/graphql',
      graphQlMultipart(operations, map, [{ content: 'payload', name: '1' }]),
    );
    return `${response.status} ${response.body.slice(0, 80)}`;
  } catch (error) {
    return `request failed: ${(error as Error).message}`;
  }
}

async function run(): Promise<void> {
  const { port } = server.address() as AddressInfo;
  const deepPath = ['variables', ...Array<string>(keys - 1).fill('a')].join('.');

  const outcome = await send(port, { '1': [deepPath] }, { query: '{ __typename }', variables: {} });
  const next = await send(port, { '1': ['variables.file'] }, { query: '{ __typename }', variables: { file: null } });

  server.closeAllConnections();
  server.close();
  process.stdout.write(`RESPONSE ${outcome}\nNEXT ${next}\nALIVE\n`, () => process.exit(0));
}
