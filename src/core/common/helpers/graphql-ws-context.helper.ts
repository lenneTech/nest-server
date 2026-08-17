// `require`, NOT an ESM import: `@nestjs/graphql` builds the schema with the instance Node's CJS
// cache holds, and graphql REFUSES a schema "from another module or realm". An ESM import can resolve
// to a second copy of the module (a bundler's interop namespace, or a duplicated install), and the
// wrapper would then reject the very schema it was handed. The repo already uses this form for
// `graphql-upload` and `lodash` for the same reason.
import graphql = require('graphql');

import { getTenantContextResolver } from '../services/core-tenant-context.registry';
import { ConfigService } from '../services/config.service';
import { IRequestContext, RequestContext } from '../services/request-context.service';

/**
 * A `RequestContext` for GraphQL operations that arrive over a WEBSOCKET.
 *
 * WHY THIS EXISTS — the gap it closes is a silent, complete tenant bypass:
 *
 * `RequestContextMiddleware` is Express middleware (`consumer.apply(...).forRoutes('*')`). A
 * WebSocket UPGRADE is not a `request` event, so it traverses no middleware — and `CoreTenantGuard`
 * cannot help either, because its `getRequest()` looks for `context.req`, which a subscription
 * context (the graphql-ws `extra` object) does not have, so the guard returns `true` without
 * deciding anything.
 *
 * The consequence was invisible from the query itself. `mongooseTenantPlugin.shouldBypass()` reads
 * "no RequestContext" as "system operation, no filter" — correct for a cron job or a migration, and
 * exactly wrong here. So a tenant-scoped read performed while delivering a subscription message
 * returned EVERY tenant's rows, and the plugin's own safety net (which throws when a tenant-scoped
 * schema is touched without a tenant) never fired, because there was no context to notice.
 *
 * WHERE IT HOOKS IN: `GqlSubscriptionService` reads `execute` and `subscribe` off the GraphQL module
 * options and hands them to BOTH WebSocket transports (`graphql-ws` and `subscriptions-transport-ws`),
 * defaulting to graphql-js's own. Those two functions are the only place where the whole WS operation
 * — including every field resolver and the `resolve`/`filter` callbacks of a subscription — is
 * reachable as one call. HTTP does not go through them (Apollo runs its own pipeline), so wrapping
 * them touches the WS path only.
 *
 * THE ASYNC-ITERATOR PART IS LOAD-BEARING. `subscribe()` returns an AsyncIterator, and graphql-js
 * runs the per-event execution — `resolve`, `filter`, every field resolver — inside that iterator's
 * `next()`, which the transport pulls LONG AFTER `subscribe()` returned. Establishing the context
 * only around the `subscribe()` call therefore covers the initial subscribe and nothing else: the
 * store is gone by the time the first message is delivered. Wrapping `next()` (and `return`/`throw`)
 * is what puts every delivered message inside the context.
 */

/** Minimal shape of what graphql-js `execute`/`subscribe` receive. */
interface GraphQlArgs {
  contextValue?: any;
  [key: string]: any;
}

type ExecuteFn = (args: GraphQlArgs) => any;

/**
 * Read the tenant header out of whatever the transport left on the context.
 *
 * Both WS transports are covered, and the reason there are three sources is that they genuinely
 * differ: `graphql-ws` gets `extra.headers` from `CoreModule`'s `onConnect` (the client's
 * `connectionParams`), `subscriptions-transport-ws` returns `{ headers }` from its own `onConnect`,
 * and the raw upgrade request is the fallback for a project with a custom `onConnect` that forwards
 * neither. Header names are matched case-insensitively — `connectionParams` are client-supplied JSON
 * and arrive with whatever casing the client used, unlike Node's lower-cased HTTP headers.
 */
function readTenantHeader(contextValue: any): string | undefined {
  const headerName = (ConfigService.configFastButReadOnly?.multiTenancy?.headerName ?? 'x-tenant-id').toLowerCase();
  const sources = [contextValue?.headers, contextValue?.connectionParams, contextValue?.request?.headers];
  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (key.toLowerCase() === headerName && typeof value === 'string' && value) {
        return value;
      }
    }
  }
  return undefined;
}

/** The user the connection authenticated as, as `CoreModule`'s `onConnect` recorded it. */
function readUser(contextValue: any): any {
  return contextValue?.user ?? contextValue?.extra?.user ?? undefined;
}

/**
 * Build the context for one WebSocket operation.
 *
 * Returns `undefined` when the operation is NOT a WebSocket one (an HTTP context carries `req`, and
 * the middleware has already established a context for it) — wrapping that again would replace a
 * live, lazily-evaluated context with a snapshot.
 */
export async function buildWsRequestContext(contextValue: any): Promise<IRequestContext | undefined> {
  if (!contextValue || typeof contextValue !== 'object' || contextValue.req) {
    return undefined;
  }

  const user = readUser(contextValue);
  const context: IRequestContext = { currentUser: user };

  // Language: same source as the HTTP path, when the transport carried it.
  const acceptLanguage =
    contextValue.headers?.['accept-language'] ??
    contextValue.connectionParams?.['accept-language'] ??
    contextValue.request?.headers?.['accept-language'];
  if (typeof acceptLanguage === 'string') {
    context.language = acceptLanguage;
  }

  const resolver = getTenantContextResolver();
  if (resolver) {
    // A failure here must NOT be answered with an unscoped context — that is the leak this file
    // exists to close. Leaving the tenant fields unset makes the plugin's safety net refuse
    // tenant-scoped reads, which is the safe direction.
    try {
      Object.assign(context, await resolver.resolve(user, readTenantHeader(contextValue)));
    } catch {
      // Intentionally swallowed: see above. Non-tenant operations keep working.
    }
  }

  return context;
}

/**
 * Run an AsyncIterator's pulls inside `context`.
 *
 * `next()` is where graphql-js executes the per-event selection set, so this is what carries the
 * context into every delivered message rather than only into the initial subscribe.
 */
export function withRequestContextAsyncIterator<T>(
  iterator: AsyncIterator<T> & { [Symbol.asyncIterator]?: () => AsyncIterator<T> },
  context: IRequestContext,
): AsyncIterableIterator<T> {
  const wrapped: AsyncIterableIterator<T> = {
    next: (...args: [] | [undefined]) => RequestContext.run(context, () => iterator.next(...(args as []))),
    [Symbol.asyncIterator]() {
      return wrapped;
    },
  };
  if (iterator.return) {
    wrapped.return = (value?: any) => RequestContext.run(context, () => iterator.return!(value));
  }
  if (iterator.throw) {
    wrapped.throw = (error?: any) => RequestContext.run(context, () => iterator.throw!(error));
  }
  return wrapped;
}

/** Is this an AsyncIterator (a subscription source) rather than a plain execution result? */
function isAsyncIterable(value: any): boolean {
  return !!value && typeof value === 'object' && typeof value[Symbol.asyncIterator] === 'function';
}

/**
 * Wrap graphql-js `execute` so a query/mutation sent over the WebSocket runs in a request context.
 *
 * Not only subscriptions: `graphql-ws` carries queries and mutations too, and those had the same gap.
 */
export function createRequestContextAwareExecute(execute: ExecuteFn): ExecuteFn {
  return async (args: GraphQlArgs) => {
    const context = await buildWsRequestContext(args?.contextValue);
    if (!context) {
      return execute(args);
    }
    return RequestContext.run(context, () => execute(args));
  };
}

/** Wrap graphql-js `subscribe` so both the subscribe AND every delivered message run in a context. */
export function createRequestContextAwareSubscribe(subscribe: ExecuteFn): ExecuteFn {
  return async (args: GraphQlArgs) => {
    const context = await buildWsRequestContext(args?.contextValue);
    if (!context) {
      return subscribe(args);
    }
    const result = await RequestContext.run(context, () => subscribe(args));
    return isAsyncIterable(result) ? withRequestContextAsyncIterator(result as AsyncIterator<any>, context) : result;
  };
}

/**
 * The pair `CoreModule` installs — graphql's own `execute` / `subscribe`, wrapped.
 *
 * Zero-arg factories rather than pre-built constants so nothing is captured at module-evaluation
 * time, and so `core.module.ts` needs no graphql import of its own (see the `require` note at the top
 * of this file for why that import form matters).
 */
export function buildRequestContextAwareExecute(): (args: GraphQlArgs) => any {
  return createRequestContextAwareExecute(graphql.execute as any);
}

export function buildRequestContextAwareSubscribe(): (args: GraphQlArgs) => any {
  return createRequestContextAwareSubscribe(graphql.subscribe as any);
}
