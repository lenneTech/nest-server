/**
 * Type definitions for graphql-upload
 * graphql-upload uses deep imports, so we declare types for the specific modules.
 *
 * Since graphql-upload 16 the package is ESM: its `exports` map lists only the `.mjs` deep paths, each
 * with a default export, and it ships no declaration files (its types are JSDoc inside the `.mjs`
 * sources, which TypeScript does not read from `node_modules`). Both names below are the ones the
 * framework imports.
 */

declare module 'graphql-upload/graphqlUploadExpress.mjs' {
  import { RequestHandler } from 'express';

  interface GraphQLUploadOptions {
    maxFiles?: number;
    maxFileSize?: number;
  }

  export default function graphqlUploadExpress(options?: GraphQLUploadOptions): RequestHandler;
}

declare module 'graphql-upload/GraphQLUpload.mjs' {
  import { GraphQLScalarType } from 'graphql';

  const GraphQLUpload: GraphQLScalarType;

  export default GraphQLUpload;
}
