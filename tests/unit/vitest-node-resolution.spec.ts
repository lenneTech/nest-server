/**
 * The test runner must resolve packages the way Node does at runtime.
 *
 * graphql declares `"main": "index"` (no extension) next to an `index.mjs` and has no `exports` map. Node resolves
 * that to `index.js` — for `require` and for `import` alike — while Vite probes `.mjs` first. Under vitest an `import`
 * of graphql therefore loaded a second, ESM copy, and anything built by the copy @nestjs/graphql uses (the schema) was
 * refused by ours. Production never had two copies; the tests did, as soon as the source switched from
 * `import graphql = require('graphql')` to `import * as graphql from 'graphql'` (12.0.0, valid as CommonJS and ESM).
 *
 * @regression   12.0.0 — every GraphQL subscription in the e2e suites closed with 4500: "Cannot use GraphQLSchema
 *   from another module or realm", because the WebSocket `execute`/`subscribe` wrappers ran graphql's ESM build against
 *   a schema from its CommonJS build.
 * @seen-failing Drop `resolve.extensions` from vitest.config.mts — registered as mutation
 *   `vitest-resolves-graphql-esm-build` in tests/regression-mutations.json.
 */
import * as graphql from 'graphql';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('vitest resolves packages like Node', () => {
  it('an `import` of graphql is the instance Node and `require` load', () => {
    const nodeGraphql = createRequire(resolve(process.cwd(), 'package.json'))('graphql');
    expect(graphql.GraphQLSchema).toBe(nodeGraphql.GraphQLSchema);
    expect(graphql.execute).toBe(nodeGraphql.execute);
  });
});
