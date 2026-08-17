/**
 * The request-like object a guard decides on, for EVERY transport — including the GraphQL WebSocket.
 *
 * WHY THIS EXISTS: all three role guards resolved the request the same way, and all three got the
 * WebSocket wrong in the same way:
 *
 * ```typescript
 * ctx.getContext()?.req || context.switchToHttp().getRequest()
 * ```
 *
 * A subscription's GraphQL context is the graphql-ws `extra` object, which has no `req`. The HTTP
 * fallback then runs on a GraphQL context, where `switchToHttp().getRequest()` yields the resolver's
 * ROOT value — `undefined` at subscribe time. So the guards were handed nothing, and what they did
 * with nothing differed in the worst possible way:
 *
 * - `CoreTenantGuard` hit `if (!request) return true` and GRANTED access without deciding anything.
 *   With multi-tenancy active the role guard PASSES non-system roles through to it, so `@Roles()` on a
 *   subscription was checked by nobody at all: a plain `member` reached a `tenantAdmin`-gated
 *   subscription and received its messages.
 * - Without multi-tenancy the role guard found no token and refused EVERYONE, so the same decorator
 *   silently meant "locked" instead of "open".
 *
 * Both are wrong, and the first is a hole. Everything a guard needs is present on the subscription
 * context — `CoreModule`'s `onConnect` records the authenticated `user` and the client's
 * `connectionParams` as `headers` — it was simply never looked at.
 *
 * DELIBERATELY IMPORT-FREE apart from the Nest types it is typed against, so it stays usable from
 * `src/core/common/**` and from `src/core/modules/**` alike without adding an import edge between
 * them. See `.claude/rules/architecture.md` → "DI Token Placement (SWC-Safe)".
 */
import type { ExecutionContext } from '@nestjs/common';

/**
 * The shape a guard reads and writes. It is deliberately loose: on HTTP this IS the Express request,
 * and on a WebSocket it is the graphql-ws `extra` object, which a guard may annotate the same way
 * (`tenantId`, `tenantRole`, …) — those writes are inert on that path, because the Mongoose plugins
 * read the WebSocket's tenant scope from `RequestContext` instead (see `graphql-ws-context.helper`).
 */
export interface GuardRequestLike {
  [key: string]: any;
  headers?: Record<string, any>;
  user?: any;
}

/**
 * Is this object plausibly a request/subscription context rather than a resolver root value?
 *
 * The check is on the KEYS a guard actually reads. A payload object that happens to carry a `user`
 * field would otherwise be mistaken for an authenticated request — and a subscription payload very
 * plausibly does (`pubSub.publish('userCreated', user)`), which would turn the PUBLISHED user into
 * the apparent caller. Requiring the graphql-ws marker (`socket` / `request` / `connectionParams`)
 * rules that out: a payload does not carry those.
 */
function isSubscriptionContext(value: any): boolean {
  return (
    !!value && typeof value === 'object' && ('socket' in value || 'connectionParams' in value || 'request' in value)
  );
}

/**
 * Resolve the object a guard should decide on.
 *
 * Order matters:
 *  1. `ctx.getContext().req` — HTTP GraphQL, and the shape every existing consumer expects.
 *  2. The graphql-ws subscription context itself, when it looks like one (see above).
 *  3. `switchToHttp().getRequest()` — REST controllers. On a GraphQL context this returns the
 *     resolver root, which is why it comes LAST and why step 2 must not fall through to it.
 *
 * @returns the request-like object, or `undefined` when the context carries none. A guard must treat
 *   `undefined` as "no information", never as "permitted" — that conflation is what this file fixes.
 */
export function resolveGuardRequest(
  context: ExecutionContext,
  gqlContextOf: (context: ExecutionContext) => any,
): GuardRequestLike | undefined {
  let gqlContext: any;
  try {
    gqlContext = gqlContextOf(context);
  } catch {
    gqlContext = undefined;
  }

  if (gqlContext?.req) {
    return gqlContext.req;
  }

  if (isSubscriptionContext(gqlContext)) {
    // Normalize the two names the transports use, so a guard reads `headers` unconditionally:
    // `graphql-ws` gets them from CoreModule's onConnect, `subscriptions-transport-ws` from its own,
    // and the raw upgrade request is the fallback for a custom onConnect that forwards neither.
    if (!gqlContext.headers) {
      gqlContext.headers = gqlContext.connectionParams ?? gqlContext.request?.headers ?? {};
    }
    return gqlContext;
  }

  try {
    return context.switchToHttp().getRequest();
  } catch {
    return undefined;
  }
}
