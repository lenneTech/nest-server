import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The WIRING of the WebSocket request context, asserted structurally over `src/core.module.ts`.
 *
 * `tests/tenant-context-surfaces.e2e-spec.ts` proves the MECHANISM: a subscription message delivered
 * over a real socket arrives inside a `RequestContext`, and a tenant-scoped read from there is scoped
 * or refused. It cannot prove the wiring, because it builds its own bare GraphQL app — booting the
 * assembled `CoreModule` three times (IAM, lazy-IAM, legacy) with a live WebSocket per driver is a
 * cost that buys nothing the source cannot state.
 *
 * What can go wrong here is specific and silent, which is why it gets its own guard:
 *
 *  1. **`CoreModule` has THREE GraphQL driver builders** (IAM, lazy IAM for `autoRegister: false`,
 *     and legacy auth). A change applied to one of them leaves the other two with no request context
 *     at all, and only the configuration that uses that builder is affected — so a project on a
 *     different auth mode inherits the leak with every test green.
 *
 *  2. **The pair must sit INSIDE `subscriptions`.** `ApolloDriver.start()` forwards only
 *     `{ schema, path, context, ...options.subscriptions }` to `GqlSubscriptionService`, so a
 *     top-level `execute` / `subscribe` is dropped without a word. That is not a hypothetical: it was
 *     the first attempt, and the e2e suite failed with the pair present but ignored.
 *
 * A runtime guard catches the CRASH, never the silent disarming of a safety property — which is why
 * this reads the source rather than the behaviour. Same reasoning as
 * `tests/unit/import-cycle-invariants.spec.ts`.
 */
describe('WebSocket request-context wiring in CoreModule', () => {
  const source = readFileSync(join(__dirname, '..', '..', 'src', 'core.module.ts'), 'utf8');

  /** Every GraphQL driver builder is identified by its `autoSchemaFile` line. */
  const builderCount = source.split("autoSchemaFile: 'schema.gql'").length - 1;

  it('has the expected number of GraphQL driver builders', () => {
    // A NEW builder must be wired too. If this number changes, add the pair to the new builder and
    // update this expectation in the same commit — do not simply raise the number.
    expect(builderCount, 'GraphQL driver builders in core.module.ts').toBe(3);
  });

  it('installs the context-aware execute and subscribe in EVERY builder', () => {
    expect(source.split('execute: buildRequestContextAwareExecute()').length - 1).toBe(builderCount);
    expect(source.split('subscribe: buildRequestContextAwareSubscribe()').length - 1).toBe(builderCount);
  });

  it('places the pair inside `subscriptions`, where the Apollo driver forwards it', () => {
    // Each builder's `subscriptions: {` must be followed by the pair BEFORE the transport keys —
    // outside that object the driver silently drops them.
    const blocks = source.split('subscriptions: {').slice(1);
    expect(blocks).toHaveLength(builderCount);
    for (const block of blocks) {
      const executeAt = block.indexOf('execute: buildRequestContextAwareExecute()');
      const subscribeAt = block.indexOf('subscribe: buildRequestContextAwareSubscribe()');
      const transportAt = block.indexOf("'graphql-ws'");
      expect(executeAt, 'execute wrapper inside subscriptions').toBeGreaterThan(-1);
      expect(subscribeAt, 'subscribe wrapper inside subscriptions').toBeGreaterThan(-1);
      expect(executeAt, 'execute wrapper before the transport config').toBeLessThan(transportAt);
      expect(subscribeAt, 'subscribe wrapper before the transport config').toBeLessThan(transportAt);
    }
  });

  it('does NOT import graphql through an ESM specifier in core.module.ts', () => {
    // graphql refuses a schema "from another module or realm", and an ESM import can resolve to a
    // second copy of the module. The helper resolves it via `require` for exactly that reason, so
    // core.module.ts must not reintroduce the import here.
    expect(source).not.toMatch(/from 'graphql';/);
  });
});
