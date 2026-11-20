/**
 * Child fixture for `../graphql-upload-process-request.spec.ts`: an Express server with graphql-upload's
 * `graphqlUploadExpress()`, then the framework's REAL `ComplexityPlugin` against a real schema with graphql-upload's
 * own `GraphQLUpload` scalar, and the framework's process diagnostics. It sends itself ONE multipart request whose
 * `map` is `{"1":["variables.files.<argv[3]>"]}` — no file field. The spec starts it with a constrained heap
 * (`--max-old-space-size=128`).
 *
 * object-path reads `4294967294` as a number and creates an array for `variables.files`, so an unbounded parser hands
 * the plugin an array of 4,294,967,295 elements. The field takes `[Upload]`: GraphQL coerces every hole of a NULLABLE
 * list item to `null` without an error, so no error cap stops the walk — only the parser's bound does.
 *
 * `argv[2]`: `default` uses graphql-upload's own `processRequest`, `framework` the framework's
 * `processGraphQlUploadRequest`. Prints `RESPONSE <status> <body start>`, then `NEXT <status> <body>` for an ordinary
 * upload sent afterwards, then `ALIVE`, and exits 0. Heap exhaustion ends the process before that.
 *
 * Not a `*.spec.ts`, so neither vitest runner picks it up as a suite. `ComplexityPlugin` is skipped under vitest in
 * `CoreModule`, which is why the fixture drives it directly.
 */
import express from 'express';
import {
  getOperationAST,
  GraphQLBoolean,
  GraphQLInt,
  GraphQLList,
  GraphQLObjectType,
  GraphQLSchema,
  parse,
} from 'graphql';
import GraphQLUpload = require('graphql-upload/GraphQLUpload.js');
import graphqlUploadExpress = require('graphql-upload/graphqlUploadExpress.js');

import { processGraphQlUploadRequest } from '../../../src/core/common/helpers/graphql-upload.helper';
import { installProcessDiagnostics } from '../../../src/core/common/helpers/process-diagnostics.helper';
import { ComplexityPlugin } from '../../../src/core/common/plugins/complexity.plugin';
import { graphQlMultipart, postMultipart } from '../../helpers/graphql-multipart';

import type { ConfigService } from '../../../src/core/common/services/config.service';
import type { GraphQLSchemaHost } from '@nestjs/graphql';
import type { ErrorRequestHandler } from 'express';
import type { AddressInfo } from 'node:net';

installProcessDiagnostics();

const mode = process.argv[2];
const index = process.argv[3];
if ((mode !== 'default' && mode !== 'framework') || !/^\d+$/.test(index ?? '')) {
  process.stderr.write(`usage: <default|framework> <index>, got '${mode}' '${index}'\n`);
  process.exit(2);
}

const schema = new GraphQLSchema({
  mutation: new GraphQLObjectType({
    fields: { uploadFiles: { args: { files: { type: new GraphQLList(GraphQLUpload) } }, type: GraphQLBoolean } },
    name: 'Mutation',
  }),
  query: new GraphQLObjectType({ fields: { ping: { type: GraphQLInt } }, name: 'Query' }),
});
const plugin = new ComplexityPlugin(
  { schema } as GraphQLSchemaHost,
  { getFastButReadOnly: () => 100 } as unknown as ConfigService,
);
const QUERY = 'mutation($files: [Upload]) { uploadFiles(files: $files) }';

const errorAsText: ErrorRequestHandler = (error, _request, response, _next) => {
  response.status(error?.status ?? 500).send(String(error?.message));
};

const app = express();
app.use(
  '/graphql',
  graphqlUploadExpress(mode === 'framework' ? { processRequest: processGraphQlUploadRequest } : {}),
  async (request, response, next) => {
    try {
      const { operationName, query, variables } = request.body as Record<string, any>;
      const listener = await plugin.requestDidStart();
      const document = parse(query);
      // As Apollo does: the operation resolved by getOperationAST(), `undefined` when there is none.
      const operation = getOperationAST(document, operationName) ?? undefined;
      await listener.didResolveOperation({ document, operation, request: { operationName, variables } } as never);
      response.send('OK');
    } catch (error) {
      next(error);
    }
  },
);
app.use(errorAsText);

const server = app.listen(0, '127.0.0.1', () => {
  void run();
});

/** Sends one request and describes its outcome as `<status> <body start>`. */
async function send(
  port: number,
  map: Record<string, string[]>,
  variables: Record<string, unknown>,
  withFile: boolean,
): Promise<string> {
  try {
    const files = withFile ? [{ content: 'payload', name: '1' }] : [];
    const response = await postMultipart(port, '/graphql', graphQlMultipart({ query: QUERY, variables }, map, files));
    return `${response.status} ${response.body.slice(0, 80)}`;
  } catch (error) {
    return `request failed: ${(error as Error).message}`;
  }
}

async function run(): Promise<void> {
  const { port } = server.address() as AddressInfo;

  const outcome = await send(port, { '1': [`variables.files.${index}`] }, {}, false);
  const next = await send(port, { '1': ['variables.files.0'] }, { files: [null] }, true);

  server.closeAllConnections();
  server.close();
  process.stdout.write(`RESPONSE ${outcome}\nNEXT ${next}\nALIVE\n`, () => process.exit(0));
}
