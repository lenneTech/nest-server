/**
 * Type definitions for graphql-upload
 * graphql-upload uses deep imports, so we declare types for the specific modules
 */

declare module 'graphql-upload/graphqlUploadExpress.js' {
  import { RequestHandler } from 'express';

  interface GraphQLUploadOptions {
    maxFiles?: number;
    maxFileSize?: number;
  }

  function graphqlUploadExpress(options?: GraphQLUploadOptions): RequestHandler;

  export = graphqlUploadExpress;
}

declare module 'graphql-upload/GraphQLUpload.js' {
  import { GraphQLScalarType } from 'graphql';

  const GraphQLUpload: GraphQLScalarType;

  export = GraphQLUpload;
}
