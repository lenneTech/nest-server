/**
 * Child fixture for `../graphql-upload-process-request.spec.ts`: an Express server with graphql-upload's
 * `graphqlUploadExpress()` and the framework's REAL process diagnostics — `installProcessDiagnostics()`, which a
 * project installs in `main.ts` and which exits on an uncaught exception — that sends itself the request of
 * GHSA-5vm7-vc2x-p3w2's proof of concept (`CRASH_MAP` without file fields).
 *
 * `argv[2]`: `default` uses graphql-upload's own `processRequest`, `framework` the framework's
 * `processGraphQlUploadRequest`. Prints `RESPONSE <status> <body>` and `ALIVE` once the request has been answered and
 * the process survived a grace period, then exits 0. An uncaught exception ends the process before that.
 *
 * Not a `*.spec.ts`, so neither vitest runner picks it up as a suite.
 */
import express from 'express';
import graphqlUploadExpress from 'graphql-upload/graphqlUploadExpress.mjs';

import { processGraphQlUploadRequest } from '../../../src/core/common/helpers/graphql-upload.helper';
import { installProcessDiagnostics } from '../../../src/core/common/helpers/process-diagnostics.helper';
import { CRASH_MAP, CRASH_OPERATIONS, graphQlMultipart, postMultipart } from '../../helpers/graphql-multipart';

import type { ErrorRequestHandler } from 'express';
import type { AddressInfo } from 'node:net';

installProcessDiagnostics();

const mode = process.argv[2];
if (mode !== 'default' && mode !== 'framework') {
  process.stderr.write(`unknown mode '${mode}', expected 'default' or 'framework'\n`);
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

async function run(): Promise<void> {
  const { port } = server.address() as AddressInfo;
  let outcome: string;
  try {
    const response = await postMultipart(port, '/graphql', graphQlMultipart(CRASH_OPERATIONS, CRASH_MAP));
    outcome = `${response.status} ${response.body}`;
  } catch (error) {
    outcome = `request failed: ${(error as Error).message}`;
  }

  // The parser's `finish` handler throws while the request is still being processed; the grace period also lets a
  // throw from a later listener (the response's `close`, where the temporary files are released) surface before the
  // process reports that it survived.
  setTimeout(() => {
    server.closeAllConnections();
    server.close();
    process.stdout.write(`RESPONSE ${outcome}\nALIVE\n`, () => process.exit(0));
  }, 500);
}
