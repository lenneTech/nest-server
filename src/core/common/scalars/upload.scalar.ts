import type { GraphQLScalarType } from 'graphql';
import GraphQLUploadScalar from 'graphql-upload/GraphQLUpload.mjs';

/**
 * The GraphQL `Upload` scalar for multipart file uploads — import it from `@lenne.tech/nest-server`,
 * not from `graphql-upload`.
 *
 * The scalar accepts a value only if it is `instanceof Upload` of ITS copy of graphql-upload, and the
 * `Upload` instances come from the multipart middleware `CoreModule` installs, i.e. from THIS package's
 * copy. A resolver that imports the scalar from the project's own graphql-upload therefore works only
 * while both resolve to the same version; with two copies every upload is refused as invalid. And the
 * import path itself is not stable across graphql-upload majors (15: `GraphQLUpload.js`, 16+:
 * `GraphQLUpload.mjs`, the one this package imports since 12.1.0). Importing it from here keeps scalar
 * and middleware one copy and leaves the path to the framework.
 *
 * A default import, never `import = require()` or `import * as`: graphql-upload 16+ is ESM, so under
 * `require(esm)` both of those yield the module NAMESPACE, not the scalar. Compiled to CommonJS, the
 * default import still reaches it — Node marks a required ES module that has a default export with
 * `__esModule`, which the interop helper reads.
 *
 * The path is a CONTRACT with the lt CLI: its generator checks whether `common/scalars/upload.scalar` exists in
 * the framework root (`dist/core/` in npm mode, `src/core/` vendored) and only then writes
 * `import { GraphQLUpload } from '<framework>'` for a File/FileInfo input; otherwise it falls back to
 * `import GraphQLUpload = require('graphql-upload/GraphQLUpload.js')`. Moving or renaming this file, or dropping
 * the re-export from `src/index.ts`, silently sends every newly generated resolver back to the project's own
 * graphql-upload copy. Pinned by `tests/unit/upload-scalar-contract.spec.ts`.
 */
export const GraphQLUpload: GraphQLScalarType = GraphQLUploadScalar;
