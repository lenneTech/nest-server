import {
  execute,
  getOperationAST,
  GraphQLBoolean,
  GraphQLError,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  parse,
} from 'graphql';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';
import { describe, expect, it } from 'vitest';

import { ComplexityPlugin } from '../../src/core/common/plugins/complexity.plugin';

import type { ConfigService } from '../../src/core/common/services/config.service';
import type { GraphQLSchemaHost } from '@nestjs/graphql';

/**
 * `ComplexityPlugin` — the Apollo plugin `CoreModule` registers for every GraphQL request (skipped under vitest in
 * `CoreModule`, so these cases drive it directly). It runs in `didResolveOperation`, after parsing and validation and
 * before execution, for every caller: no guard has run yet.
 */

/** Items of the invalid list: 40 KB of `0,` — small enough to stay cheap if the cap is missing. */
const INVALID_ITEMS = 20_000;

/** A schema whose Upload scalar refuses every value (as graphql-upload's does for a non-Upload) and counts the calls. */
function uploadSchema(): { parseValueCalls: () => number; schema: GraphQLSchema } {
  let calls = 0;
  const Upload = new GraphQLScalarType({
    name: 'Upload',
    parseValue() {
      calls++;
      throw new GraphQLError('Upload value invalid.');
    },
  });
  const schema = new GraphQLSchema({
    mutation: new GraphQLObjectType({
      fields: {
        uploadFiles: {
          args: { files: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Upload))) } },
          type: GraphQLBoolean,
        },
      },
      name: 'Mutation',
    }),
    query: new GraphQLObjectType({ fields: { ping: { type: GraphQLInt } }, name: 'Query' }),
  });
  return { parseValueCalls: () => calls, schema };
}

/** A schema of three plain fields, one with an argument: `{ a b c(n: $n) }` costs 3. */
const plainSchema = new GraphQLSchema({
  query: new GraphQLObjectType({
    fields: {
      a: { type: GraphQLInt },
      b: { type: GraphQLInt },
      c: { args: { n: { type: new GraphQLNonNull(GraphQLInt) } }, type: GraphQLInt },
    },
    name: 'Query',
  }),
});

/** Runs the plugin's `didResolveOperation` the way Apollo calls it. */
async function didResolveOperation(
  schema: GraphQLSchema,
  maxComplexity: number,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): Promise<void> {
  const plugin = new ComplexityPlugin(
    { schema } as GraphQLSchemaHost,
    { getFastButReadOnly: () => maxComplexity } as unknown as ConfigService,
  );
  const listener = await plugin.requestDidStart();
  const document = parse(query);
  // Apollo resolves the operation with graphql's getOperationAST() and passes `undefined` when there is none.
  const operation = getOperationAST(document, operationName) ?? undefined;
  await listener.didResolveOperation({ document, operation, request: { operationName, variables } } as never);
}

/** The complexity the plugin computes: with `maxComplexity: 0` every operation is refused with its number. */
async function pluginComplexity(schema: GraphQLSchema, query: string, variables: Record<string, unknown> = {}) {
  const error: Error = await didResolveOperation(schema, 0, query, variables).then(
    () => {
      throw new Error('expected a refusal');
    },
    (refusal: Error) => refusal,
  );
  const match = /^Query is too complex: (\d+)\./.exec(error.message);
  if (!match) {
    throw error;
  }
  return Number(match[1]);
}

/** The complexity graphql-query-complexity's own getComplexity() computes for the same document. */
function libraryComplexity(schema: GraphQLSchema, query: string, variables: Record<string, unknown> = {}): number {
  return getComplexity({
    estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
    query: parse(query),
    schema,
    variables,
  });
}

/** A schema with a `Count` scalar that counts how often its literals and values are coerced, and a non-null argument. */
function countingSchema(): { literalCalls: () => number; schema: GraphQLSchema; valueCalls: () => number } {
  let literals = 0;
  let values = 0;
  const Count = new GraphQLScalarType({
    name: 'Count',
    parseLiteral() {
      literals++;
      return 1;
    },
    parseValue(value) {
      values++;
      return value;
    },
  });
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      fields: {
        a: { type: GraphQLInt },
        c: { args: { n: { type: new GraphQLList(Count) } }, type: GraphQLInt },
        g: { args: { id: { type: new GraphQLNonNull(GraphQLInt) } }, type: GraphQLInt },
      },
      name: 'Query',
    }),
  });
  return { literalCalls: () => literals, schema, valueCalls: () => values };
}

/**
 * @regression   12.10.1 — ComplexityPlugin called getComplexity(), which coerces the request's variables without an
 *   error cap: a list of invalid items (`{"f":[0,0,…]}` for `$f: [Upload!]!`) created one GraphQLError per item —
 *   1.5 s of blocked event loop and 300 MB for 100 KB, 15 s and 2 GB for 1 MB, from any anonymous request, a plain JSON
 *   POST included.
 * @seen-failing Registered in tests/regression-mutations.json: `complexity-variables-uncapped` (the pre-check gone:
 *   the Upload scalar is asked 20,000 times instead of at most 2, and the plugin throws the last coercion error) and
 *   `complexity-precheck-builds-50-errors` (the pre-check at execution's cap: 51 calls, 51 located errors).
 */
describe('ComplexityPlugin: variables are coerced with an error cap before getComplexity()', () => {
  it('stops at the cap on a huge invalid list and leaves the refusal to execution', async () => {
    const { parseValueCalls, schema } = uploadSchema();
    const variables = { f: Array.from({ length: INVALID_ITEMS }, () => 0) };

    await expect(
      didResolveOperation(schema, 100, 'mutation($f: [Upload!]!) { uploadFiles(files: $f) }', variables),
    ).resolves.toBeUndefined();

    // One error, then the second stops the coercion; getComplexity() never coerced the list.
    expect(parseValueCalls()).toBeLessThanOrEqual(2);
  });

  it('premise: graphql execute() refuses the same variables with its own cap, before any resolver runs', async () => {
    const { parseValueCalls, schema } = uploadSchema();

    const result = await execute({
      document: parse('mutation($f: [Upload!]!) { uploadFiles(files: $f) }'),
      rootValue: { uploadFiles: () => true },
      schema,
      variableValues: { f: Array.from({ length: INVALID_ITEMS }, () => 0) },
    });

    expect(result.data).toBeUndefined();
    expect(result.errors?.length).toBeLessThanOrEqual(51);
    expect(result.errors?.at(-1)?.message).toMatch(/error limit reached/);
    expect(parseValueCalls()).toBeLessThanOrEqual(51);
  });

  it('still computes and enforces the complexity of an operation with valid variables', async () => {
    const query = 'query($n: Int!) { a b c(n: $n) }';

    await expect(didResolveOperation(plainSchema, 2, query, { n: 1 })).rejects.toThrow(
      /^Query is too complex: 3\. Maximum allowed complexity: 2$/,
    );
    await expect(didResolveOperation(plainSchema, 3, query, { n: 1 })).resolves.toBeUndefined();
  });

  it('checks only the resolved operation, so another operation cannot switch the check off', async () => {
    // `Other` never runs, and its `$f` is invalid. Checking it would skip the complexity of `Big`, which does run.
    const { schema: uploads } = uploadSchema();
    const schema = new GraphQLSchema({
      mutation: uploads.getMutationType(),
      query: plainSchema.getQueryType(),
    });
    const query = 'query Big { a b c(n: 1) } mutation Other($f: [Upload!]!) { uploadFiles(files: $f) }';

    await expect(didResolveOperation(schema, 2, query, { f: [0, 0, 0] }, 'Big')).rejects.toThrow(
      /^Query is too complex: 3\./,
    );
  });
});

/**
 * @regression   12.10.1 — with several operations and no `operationName`, Apollo resolves none and still calls
 *   didResolveOperation(); getComplexity() evaluated EVERY operation and coerced the variables for each: 860
 *   operations sharing one 16,000-item variable blocked the event loop for 5.9 s from a 100 KB JSON POST (SEC-3).
 * @seen-failing Registered in tests/regression-mutations.json: `complexity-coerces-every-operation` (the variables
 *   coerced for every operation: the `Count` scalar is asked 20,000 times instead of never).
 */
describe('ComplexityPlugin: a document without a resolved operation is left to execution', () => {
  it('coerces no variable when Apollo resolved no operation', async () => {
    const { schema, valueCalls } = countingSchema();
    const operations = Array.from({ length: 20 }, (_, i) => `query q${i}($f: [Count]) { c(n: $f) }`).join(' ');

    await expect(
      didResolveOperation(schema, 1000, operations, { f: Array.from({ length: 1000 }, () => 0) }),
    ).resolves.toBeUndefined();

    expect(valueCalls()).toBe(0);
  });

  it('premise: graphql execute() refuses such a document before it coerces a variable', async () => {
    const { schema, valueCalls } = countingSchema();

    const result = await execute({
      document: parse('query q0($f: [Count]) { c(n: $f) } query q1($f: [Count]) { c(n: $f) }'),
      schema,
      variableValues: { f: [0, 0, 0] },
    });

    expect(result.errors?.[0]?.message).toMatch(/Must provide operation name/);
    expect(valueCalls()).toBe(0);
  });

  it('still checks the operation named by operationName', async () => {
    const { schema, valueCalls } = countingSchema();

    await expect(
      didResolveOperation(schema, 1, 'query q0($f: [Count]) { c(n: $f) a } query q1 { a }', { f: [0] }, 'q0'),
    ).rejects.toThrow(/^Query is too complex: 2\./);
    expect(valueCalls()).toBeGreaterThan(0);
  });
});

/**
 * @regression   12.10.1 — graphql-query-complexity evaluates a fragment again at every spread and coerces its literal
 *   arguments at every visit; its 10,000-node cap bounds the visits, not their cost. `{...F ×3300}` with a 41,667-item
 *   literal in F blocked the event loop for 2.2 s from a 100 KB JSON POST, 22.5 s from a 990 KB multipart request
 *   (SEC-4).
 * @seen-failing Registered in tests/regression-mutations.json: `complexity-fragments-not-cached` (every spread
 *   evaluated again: the literal is coerced 500 times instead of once) and `complexity-cached-fragments-skip-node-count`
 *   (a cached spread adds no nodes: 12,000 visits pass the 10,000-node cap).
 */
describe('ComplexityPlugin: each fragment is evaluated once', () => {
  const spreads = (count: number) => '...F '.repeat(count);

  it('coerces a literal in a fragment once, however often it is spread', async () => {
    const { literalCalls, schema } = countingSchema();

    await expect(
      didResolveOperation(schema, 100_000, `{ ${spreads(500)} } fragment F on Query { c(n: [1, 2, 3]) a }`, {}),
    ).resolves.toBeUndefined();

    expect(literalCalls()).toBe(3);
  });

  it('computes the number graphql-query-complexity computes', async () => {
    const documents = [
      `{ ${spreads(500)} } fragment F on Query { c(n: [1]) a }`,
      '{ ...F ...G a } fragment F on Query { a ...G } fragment G on Query { c(n: [1]) }',
      '{ ...F ... on Query { ...F a } } fragment F on Query { a c(n: [1]) }',
      'query($x: Boolean!) { ...F a @include(if: $x) } fragment F on Query { a @skip(if: $x) c(n: [1]) }',
    ];
    for (const query of documents) {
      const variables = { x: true };
      expect(await pluginComplexity(countingSchema().schema, query, variables)).toBe(
        libraryComplexity(countingSchema().schema, query, variables),
      );
    }
  });

  it('keeps the 10,000-node cap: the nodes of a cached fragment count at every spread', async () => {
    const { schema } = countingSchema();
    const query = (count: number) => `{ ${spreads(count)} } fragment F on Query { a }`;

    // 6,000 spreads of a one-field fragment are 12,000 visits.
    expect(() => libraryComplexity(schema, query(6000))).toThrow(/maximum allowed number of nodes/);
    await expect(didResolveOperation(schema, 1_000_000, query(6000), {})).rejects.toThrow(
      /maximum allowed number of nodes/,
    );
    await expect(didResolveOperation(schema, 1_000_000, query(4000), {})).resolves.toBeUndefined();
  });
});

/**
 * @regression   12.10.1 — graphql-query-complexity runs `Object.keys()` over the operation's variables at every field
 *   it visits: 38,000 declared variables with 4,900 visits blocked the event loop for 17 s, with variables that coerce
 *   (SEC-4).
 * @seen-failing Registered in tests/regression-mutations.json: `complexity-variable-work-unbounded` (no limit: 1,000
 *   variables with 300 fields are analysed instead of refused).
 */
describe('ComplexityPlugin: fields × declared variables are bounded', () => {
  const query = (variableCount: number, fieldCount: number) =>
    `query(${Array.from({ length: variableCount }, (_, i) => `$v${i}: Int`).join(' ')}) { ` +
    `${Array.from({ length: fieldCount }, (_, i) => `f${i}: a`).join(' ')} }`;

  it('refuses an operation whose fields × variables exceed the limit', async () => {
    await expect(didResolveOperation(plainSchema, 1000, query(1000, 300), {})).rejects.toThrow(
      /^Query is too complex: too many fields for its number of variables$/,
    );
  });

  it('accepts one below it', async () => {
    await expect(didResolveOperation(plainSchema, 1000, query(1000, 200), {})).resolves.toBeUndefined();
  });
});

/**
 * @regression   12.10.1 — the analysis went on after a field's arguments failed to coerce, and every error located
 *   itself by scanning the query: `query($x: String = "a") { a: getUser(id: $x) … }` with `{"x": null}` is valid and
 *   fails at every field — 1.4 s from a 98 KiB JSON POST, 86 s from a 993 KiB multipart request.
 * @seen-failing Registered in tests/regression-mutations.json: `complexity-analysis-collects-errors` (errors
 *   swallowed: the 100 fields after the first failing one are coerced, and the request is not refused).
 */
describe('ComplexityPlugin: the analysis stops at its first error', () => {
  it('refuses with the first argument error and coerces nothing after it', async () => {
    const { literalCalls, schema } = countingSchema();
    // `$x` has a default, so it may stand at the non-null argument; the explicit null fails at every such field.
    const failing = Array.from({ length: 100 }, (_, i) => `e${i}: g(id: $x)`).join(' ');
    const counted = Array.from({ length: 100 }, (_, i) => `c${i}: c(n: [1])`).join(' ');

    await expect(
      didResolveOperation(schema, 1_000_000, `query($x: Int = 1) { ${failing} ${counted} }`, { x: null }),
    ).rejects.toThrow(/must not be null/);
    expect(literalCalls()).toBe(0);
  });
});
