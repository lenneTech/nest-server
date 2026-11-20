/**
 * Type definitions for graphql-upload
 * graphql-upload uses deep imports, so we declare types for the specific modules
 */

declare module 'graphql-upload/graphqlUploadExpress.js' {
  import { RequestHandler } from 'express';
  import type { IncomingMessage, ServerResponse } from 'node:http';

  interface GraphQLUploadProcessRequestOptions {
    maxFieldSize?: number;
    maxFiles?: number;
    maxFileSize?: number;
  }

  interface GraphQLUploadOptions extends GraphQLUploadProcessRequestOptions {
    /**
     * The function that parses the multipart request. graphql-upload's default is its own `processRequest`, which is
     * vulnerable to GHSA-5vm7-vc2x-p3w2 and GHSA-qwwm-252j-9whw below 18.0.2 — pass the framework's
     * `processGraphQlUploadRequest`.
     */
    processRequest?: (
      request: IncomingMessage,
      response: ServerResponse,
      options?: GraphQLUploadProcessRequestOptions,
    ) => Promise<unknown>;
  }

  function graphqlUploadExpress(options?: GraphQLUploadOptions): RequestHandler;

  export = graphqlUploadExpress;
}

declare module 'graphql-upload/Upload.js' {
  /**
   * A file expected in a GraphQL multipart request, placed in the operations wherever the `map` names it. The
   * `GraphQLUpload` scalar accepts a value only if it is `instanceof` this class, of the same graphql-upload copy.
   */
  class Upload {
    /** The file's details once it streamed in (set by `resolve`). */
    file?: unknown;
    /** Resolves with the file's details; the scalar hands it to the resolver. */
    promise: Promise<unknown>;
    /** Rejects the upload (missing file, aborted request). */
    reject: (error: Error) => void;
    /** Resolves the upload with the file's details. */
    resolve: (file: unknown) => void;
  }

  export = Upload;
}

declare module 'graphql-upload/GraphQLUpload.js' {
  import { GraphQLScalarType } from 'graphql';

  const GraphQLUpload: GraphQLScalarType;

  export = GraphQLUpload;
}
