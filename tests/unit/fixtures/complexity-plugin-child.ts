/**
 * Child fixture for `../complexity-plugin.spec.ts`: runs `ComplexityPlugin` with VALID variables, so that
 * `getComplexity()` computes and the plugin enforces the result. A child process because on this line vitest loads
 * graphql's ESM build for the spec and the plugin while graphql-query-complexity requires the CommonJS build — two
 * copies of graphql, whose schemas the other copy refuses ("Cannot use GraphQLObjectType … from another module or
 * realm"). Plain Node loads one copy, as a deployed application does.
 *
 * Prints one line per case: `<case> resolved` or `<case> threw <message>`, a counter as `<case> <number>`, a comparison
 * as `<case> plugin=<n> library=<n>`, then `DONE`.
 *
 * Not a `*.spec.ts`, so neither vitest runner picks it up as a suite.
 */
import {
  getOperationAST,
  GraphQLBoolean,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  parse,
} from 'graphql';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';

import { ComplexityPlugin } from '../../../src/core/common/plugins/complexity.plugin';

import type { ConfigService } from '../../../src/core/common/services/config.service';
import type { GraphQLSchemaHost } from '@nestjs/graphql';

const Upload = new GraphQLScalarType({
  name: 'Upload',
  parseValue() {
    throw new Error('Upload value invalid.');
  },
});

/** Three plain fields, one with an argument: `{ a b c(n: $n) }` costs 3; plus a mutation that takes uploads. */
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
  query: new GraphQLObjectType({
    fields: {
      a: { type: GraphQLInt },
      b: { type: GraphQLInt },
      c: { args: { n: { type: new GraphQLNonNull(GraphQLInt) } }, type: GraphQLInt },
    },
    name: 'Query',
  }),
});

async function run(
  label: string,
  maxComplexity: number,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): Promise<void> {
  await runOn(schema, label, maxComplexity, query, variables, operationName);
}

async function runOn(
  on: GraphQLSchema,
  label: string,
  maxComplexity: number,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): Promise<void> {
  const plugin = new ComplexityPlugin(
    { schema: on } as GraphQLSchemaHost,
    { getFastButReadOnly: () => maxComplexity } as unknown as ConfigService,
  );
  const listener = await plugin.requestDidStart();
  const document = parse(query);
  // Apollo resolves the operation with graphql's getOperationAST() and passes `undefined` when there is none.
  const operation = getOperationAST(document, operationName) ?? undefined;
  try {
    await listener.didResolveOperation({ document, operation, request: { operationName, variables } } as never);
    process.stdout.write(`${label} resolved\n`);
  } catch (error) {
    process.stdout.write(`${label} threw ${(error as Error).message}\n`);
  }
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
  const counting = new GraphQLSchema({
    query: new GraphQLObjectType({
      fields: {
        a: { type: GraphQLInt },
        c: { args: { n: { type: new GraphQLList(Count) } }, type: GraphQLInt },
        g: { args: { id: { type: new GraphQLNonNull(GraphQLInt) } }, type: GraphQLInt },
      },
      name: 'Query',
    }),
  });
  return { literalCalls: () => literals, schema: counting, valueCalls: () => values };
}

/** Prints the complexity the plugin computes (`maxComplexity: 0` refuses with the number) next to the library's. */
async function compare(label: string, query: string, variables: Record<string, unknown>): Promise<void> {
  const library = getComplexity({
    estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
    query: parse(query),
    schema: countingSchema().schema,
    variables,
  });
  const plugin = new ComplexityPlugin(
    { schema: countingSchema().schema } as GraphQLSchemaHost,
    { getFastButReadOnly: () => 0 } as unknown as ConfigService,
  );
  const listener = await plugin.requestDidStart();
  const document = parse(query);
  let computed = 'none';
  try {
    await listener.didResolveOperation({
      document,
      operation: getOperationAST(document) ?? undefined,
      request: { variables },
    } as never);
  } catch (error) {
    computed = /^Query is too complex: (\d+)\./.exec((error as Error).message)?.[1] ?? (error as Error).message;
  }
  process.stdout.write(`${label} plugin=${computed} library=${library}\n`);
}

async function main(): Promise<void> {
  await run('over', 2, 'query($n: Int!) { a b c(n: $n) }', { n: 1 });
  await run('at', 3, 'query($n: Int!) { a b c(n: $n) }', { n: 1 });
  // `Other` never runs, and its `$f` is invalid: checking it would skip the complexity of `Big`, which does run.
  await run(
    'other-operation',
    2,
    'query Big { a b c(n: 1) } mutation Other($f: [Upload!]!) { uploadFiles(files: $f) }',
    { f: [0, 0, 0] },
    'Big',
  );

  // The operation named by operationName is still checked (SEC-3 skips only a document without a resolved one).
  const named = countingSchema();
  await runOn(named.schema, 'named', 1, 'query q0($f: [Count]) { c(n: $f) a } query q1 { a }', { f: [0] }, 'q0');
  process.stdout.write(`named-value-calls ${named.valueCalls()}\n`);

  // Each fragment is evaluated once (SEC-4): the literal is coerced once, not once per spread.
  const memo = countingSchema();
  await runOn(memo.schema, 'memo', 100_000, `{ ${'...F '.repeat(500)} } fragment F on Query { c(n: [1, 2, 3]) a }`, {});
  process.stdout.write(`memo-literal-calls ${memo.literalCalls()}\n`);

  const documents = [
    `{ ${'...F '.repeat(500)} } fragment F on Query { c(n: [1]) a }`,
    '{ ...F ...G a } fragment F on Query { a ...G } fragment G on Query { c(n: [1]) }',
    '{ ...F ... on Query { ...F a } } fragment F on Query { a c(n: [1]) }',
    'query($x: Boolean!) { ...F a @include(if: $x) } fragment F on Query { a @skip(if: $x) c(n: [1]) }',
  ];
  for (const [index, query] of documents.entries()) {
    await compare(`equivalence-${index}`, query, { x: true });
  }

  // The 10,000-node cap still counts the nodes of a cached fragment at every spread.
  const cap = (count: number) => `{ ${'...F '.repeat(count)} } fragment F on Query { a }`;
  await runOn(countingSchema().schema, 'node-cap-6000', 1_000_000, cap(6000), {});
  await runOn(countingSchema().schema, 'node-cap-4000', 1_000_000, cap(4000), {});

  // Fields × declared variables below the limit are analysed.
  const variablesQuery =
    `query(${Array.from({ length: 1000 }, (_, i) => `$v${i}: Int`).join(' ')}) { ` +
    `${Array.from({ length: 200 }, (_, i) => `f${i}: a`).join(' ')} }`;
  await run('variable-budget-below', 1000, variablesQuery, {});

  // The analysis stops at its first error: `$x` has a default, so it may stand at the non-null argument, and the
  // explicit null fails at every such field; nothing after the first one is coerced.
  const firstError = countingSchema();
  const failing = Array.from({ length: 100 }, (_, i) => `e${i}: g(id: $x)`).join(' ');
  const counted = Array.from({ length: 100 }, (_, i) => `c${i}: c(n: [1])`).join(' ');
  await runOn(firstError.schema, 'first-error', 1_000_000, `query($x: Int = 1) { ${failing} ${counted} }`, { x: null });
  process.stdout.write(`first-error-literal-calls ${firstError.literalCalls()}\n`);

  process.stdout.write('DONE\n', () => process.exit(0));
}

void main();
