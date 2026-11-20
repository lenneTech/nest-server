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
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ComplexityPlugin } from '../../src/core/common/plugins/complexity.plugin';

import type { ConfigService } from '../../src/core/common/services/config.service';
import type { GraphQLSchemaHost } from '@nestjs/graphql';

/**
 * `ComplexityPlugin` — the Apollo plugin `CoreModule` registers for every GraphQL request (skipped under vitest in
 * `CoreModule`, so these cases drive it directly). It runs in `didResolveOperation`, after parsing and validation and
 * before execution, for every caller: no guard has run yet.
 */

const ROOT = join(__dirname, '..', '..');
const COMPLEXITY_CHILD = join(__dirname, 'fixtures', 'complexity-plugin-child.ts');

/** Runs `fixtures/complexity-plugin-child.ts` to its end. */
function runComplexityChild(): Promise<{ code: null | number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', COMPLEXITY_CHILD], {
      cwd: ROOT,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`fixture did not end within 25 s. stdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 25_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

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

/** A schema with a `Count` scalar that counts how often its values are coerced. */
function countingSchema(): { schema: GraphQLSchema; valueCalls: () => number } {
  let values = 0;
  const Count = new GraphQLScalarType({
    name: 'Count',
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
      },
      name: 'Query',
    }),
  });
  return { schema, valueCalls: () => values };
}

/** The child's output, run once for every case that reads it. */
let childRun: Promise<{ code: null | number; stdout: string }> | undefined;
function childOutput(): Promise<{ code: null | number; stdout: string }> {
  childRun ??= runComplexityChild();
  return childRun;
}

/**
 * @regression   11.46.6 — ComplexityPlugin called getComplexity(), which coerces the request's variables without an
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

  it('still computes and enforces the complexity of valid variables, for the operation getComplexity() evaluates', async () => {
    // In a child process: on this line vitest gives the spec graphql's ESM build and graphql-query-complexity the
    // CommonJS one, and getComplexity() refuses a schema of the other copy. Plain Node loads one copy.
    const { code, stdout } = await childOutput();

    expect(stdout).toMatch(/^over threw Query is too complex: 3\. Maximum allowed complexity: 2$/m);
    expect(stdout).toMatch(/^at resolved$/m);
    // `Other` never runs and its `$f` is invalid; checking it would skip the complexity of `Big`, which does run.
    expect(stdout).toMatch(/^other-operation threw Query is too complex: 3\./m);
    expect(stdout).toContain('DONE');
    expect(code).toBe(0);
  });
});

/**
 * @regression   11.46.6 — with several operations and no `operationName`, Apollo resolves none and still calls
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
    const { stdout } = await childOutput();

    expect(stdout).toMatch(/^named threw Query is too complex: 2\./m);
    expect(stdout).toMatch(/^named-value-calls [1-9]\d*$/m);
  });
});

/**
 * @regression   11.46.6 — graphql-query-complexity evaluates a fragment again at every spread and coerces its literal
 *   arguments at every visit; its 10,000-node cap bounds the visits, not their cost. `{...F ×3300}` with a 41,667-item
 *   literal in F blocked the event loop for 2.2 s from a 100 KB JSON POST, 22.5 s from a 990 KB multipart request
 *   (SEC-4).
 * @seen-failing Registered in tests/regression-mutations.json: `complexity-fragments-not-cached` (every spread
 *   evaluated again: the literal is coerced 1,500 times instead of 3) and `complexity-cached-fragments-skip-node-count`
 *   (a cached spread adds no nodes: 12,000 visits pass the 10,000-node cap).
 */
describe('ComplexityPlugin: each fragment is evaluated once', () => {
  // In the child process, for the reason the first describe block gives.
  it('coerces a literal in a fragment once, however often it is spread', async () => {
    const { stdout } = await childOutput();

    expect(stdout).toMatch(/^memo resolved$/m);
    expect(stdout).toMatch(/^memo-literal-calls 3$/m);
  });

  it('computes the number graphql-query-complexity computes', async () => {
    const { stdout } = await childOutput();
    const lines = stdout.split('\n').filter((line) => line.startsWith('equivalence-'));

    expect(lines).toHaveLength(4);
    for (const line of lines) {
      const [, plugin, library] = /plugin=(\S+) library=(\S+)$/.exec(line) ?? [];
      expect(plugin, line).toBe(library);
    }
  });

  it('keeps the 10,000-node cap: the nodes of a cached fragment count at every spread', async () => {
    const { stdout } = await childOutput();

    // 6,000 spreads of a one-field fragment are 12,000 visits.
    expect(stdout).toMatch(/^node-cap-6000 threw Query exceeds the maximum allowed number of nodes\.$/m);
    expect(stdout).toMatch(/^node-cap-4000 resolved$/m);
  });
});

/**
 * @regression   11.46.6 — graphql-query-complexity runs `Object.keys()` over the operation's variables at every field
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
    const { schema } = countingSchema();

    await expect(didResolveOperation(schema, 1000, query(1000, 300), {})).rejects.toThrow(
      /^Query is too complex: too many fields for its number of variables$/,
    );
  });

  it('accepts one below it', async () => {
    const { stdout } = await childOutput();

    expect(stdout).toMatch(/^variable-budget-below resolved$/m);
  });
});

/**
 * @regression   11.46.6 — the analysis went on after a field's arguments failed to coerce, and every error located
 *   itself by scanning the query: `query($x: String = "a") { a: getUser(id: $x) … }` with `{"x": null}` is valid and
 *   fails at every field — 1.4 s from a 98 KiB JSON POST, 86 s from a 993 KiB multipart request.
 * @seen-failing Registered in tests/regression-mutations.json: `complexity-analysis-collects-errors` (errors
 *   swallowed: the 100 fields after the first failing one are coerced, and the request is not refused).
 */
describe('ComplexityPlugin: the analysis stops at its first error', () => {
  // In the child process, for the reason the first describe block gives.
  it('refuses with the first argument error and coerces nothing after it', async () => {
    const { stdout } = await childOutput();

    expect(stdout).toMatch(/^first-error threw .*must not be null\.$/m);
    expect(stdout).toMatch(/^first-error-literal-calls 0$/m);
  });
});
