/**
 * The `Upload` scalar's location is a contract with the lt CLI.
 *
 * The CLI's generator decides how a File/FileInfo input imports the scalar by checking whether
 * `common/scalars/upload.scalar` exists in the framework root (`dist/core/` in npm mode, `src/core/` vendored):
 * present → `import { GraphQLUpload } from '<framework>'`, absent → `import GraphQLUpload = require('graphql-upload/…')`
 * against the project's own copy. Nothing in this repository imports the file by that path from outside, so a move,
 * a rename or a dropped re-export would compile, pass every other suite and quietly change what the CLI generates.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { GraphQLUpload } from '../../src';

const root = process.cwd();

describe('Upload scalar contract with the lt CLI', () => {
  it('lives at src/core/common/scalars/upload.scalar.ts, the path the CLI probes', () => {
    expect(existsSync(resolve(root, 'src/core/common/scalars/upload.scalar.ts'))).toBe(true);
  });

  it('is re-exported from the package root, which is what the generated import names', () => {
    const index = readFileSync(resolve(root, 'src/index.ts'), 'utf8');
    expect(index).toContain("export * from './core/common/scalars/upload.scalar.js';");
  });

  it("exports graphql-upload's own scalar object, not a namespace wrapper around it", () => {
    // Identity with the module's default export: a TypeScript 6 `import * as` would hand out an `__importStar` copy,
    // which still has a `name` and a constructor called GraphQLScalarType — only identity tells the two apart.
    // graphql-upload 16+ is ESM, so require() returns its namespace and the scalar is its `default`.
    const requireFromRoot = createRequire(resolve(root, 'package.json'));
    expect(GraphQLUpload).toBe(requireFromRoot('graphql-upload/GraphQLUpload.mjs').default);
    expect(GraphQLUpload.constructor.name).toBe('GraphQLScalarType');
    expect(GraphQLUpload.name).toBe('Upload');
  });
});
