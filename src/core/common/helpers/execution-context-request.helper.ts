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
import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';

/**
 * The execution context types of an agent function call (`@nestjs/ai`, `'ai'`) and of an MCP primitive call
 * (`@nestjs/mcp`, `'mcp'`). nestjs-ai plan §1.
 *
 * Both packages wrap a method with Nest's `ExternalContextCreator`, so EVERY global guard, interceptor and filter of
 * the application runs around it — ours included, in any project that installs either package, whether or not it uses
 * the framework's own AI module. Their arguments are `[input, call]`:
 *
 * | Index | `'ai'` (`AgentFunctionContext`) | `'mcp'` (`McpContext`) | Trust |
 * |-------|---------------------------------|------------------------|-------|
 * | 0 | the tool arguments the MODEL wrote | the tool arguments the MCP CLIENT sent | none — attacker-controlled |
 * | 1 | built by `@nestjs/ai` from the call's `caller` (`request`, `user`, `scopes`) | built by `@nestjs/mcp` (`request`, `authInfo`) | server code |
 *
 * Before 12.10.0 every guard fell back to `switchToHttp().getRequest()` on such a context — which is index 0, the
 * MODEL's arguments. A tool call `{ "user": { "roles": ["admin"] } }` was then the request a guard decided on. The
 * resolvers below are duck-typed against that argument layout on purpose: `src/core/common/` imports neither package,
 * so a project without them loads nothing new.
 */
export const AGENT_CALL_CONTEXT_TYPES: ReadonlySet<string> = new Set(['ai', 'mcp']);

/**
 * The second argument of an agent or MCP call, as far as the framework reads it. Everything else on it belongs to the
 * package that built it.
 */
export interface AgentCallLike {
  /** `'mcp'` only: the verified access token, when `@nestjs/mcp`'s `auth` option is configured. */
  authInfo?: { [key: string]: unknown; extra?: Record<PropertyKey, unknown> };
  /** The agent function's / tool's name. */
  name?: string;
  /** The HTTP platform's request the call runs in; `undefined` for a queue job, a durable run, stdio. */
  request?: GuardRequestLike;
}

/**
 * Symbol under which `CoreAiMcpOAuthService.createMcpTokenVerifier()` (AI module) records the user an MCP OAuth access token belongs to,
 * in the `extra` of the `AuthInfo` it returns to `@nestjs/mcp`. A symbol rather than a string key, so a verifier of
 * another identity provider cannot name it by accident and a JSON payload cannot carry it at all. `Symbol.for`, so a
 * second copy of the framework in one process (npm and vendored) agrees on it.
 */
export const MCP_VERIFIED_USER = Symbol.for('lt.nest-server.mcp-verified-user');

/** Whether `context` is an agent function call (`'ai'`) or an MCP primitive call (`'mcp'`). */
export function isAgentCallContext(context: ArgumentsHost | undefined): boolean {
  let type: unknown;
  try {
    type = context?.getType?.();
  } catch {
    return false;
  }
  return typeof type === 'string' && AGENT_CALL_CONTEXT_TYPES.has(type);
}

/** The call object (`args[1]`) of an agent or MCP call; `undefined` for any other context. */
export function agentCallOf(context: ArgumentsHost | undefined): AgentCallLike | undefined {
  if (!isAgentCallContext(context)) {
    return undefined;
  }
  const call = context.getArgByIndex(1);
  return call && typeof call === 'object' ? (call as AgentCallLike) : undefined;
}

/**
 * The request an agent or MCP call runs in — never its arguments.
 *
 * `undefined` for a REQUEST-LESS caller: `@nestjs/ai`'s `caller: { user, scopes }` (a queue job, a durable run) or MCP
 * over stdio. The framework treats such a caller as ANONYMOUS (nestjs-ai plan §1, owner decision recorded there): its
 * `caller.user` is data the calling code put there — a job payload read back from Redis, a workflow's stored input —
 * that nothing authenticated, and the tenant scope of the data layer (`RequestContext`) has no request to come from.
 * So a role-gated agent function or tool refuses it with 401; one open to `S_EVERYONE` runs. A project that runs a
 * role-gated agent function from a job authenticates first and passes the request (`caller: { request }`).
 *
 * MCP: when the request carries no user but `@nestjs/mcp`'s `authInfo` was produced by the framework's own MCP OAuth
 * verifier (`CoreAiMcpOAuthService.createMcpTokenVerifier()`), the user that verifier loaded becomes `request.user` — the same step
 * `CoreAiMcpController.scopeLateResolvedUser()` takes for `/ai/mcp`, so the data layer sees the caller too.
 */
export function resolveAgentCallRequest(context: ArgumentsHost | undefined): GuardRequestLike | undefined {
  const call = agentCallOf(context);
  const request = call?.request;
  if (!request || typeof request !== 'object') {
    return undefined;
  }
  if (!request.user) {
    const verified = call.authInfo?.extra?.[MCP_VERIFIED_USER];
    if (verified && typeof verified === 'object') {
      request.user = verified;
    }
  }
  return request;
}

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
 *  0. An agent function or MCP call (`'ai'` / `'mcp'`): the request the call runs in, or `undefined` — never the
 *     call's arguments, which the HTTP fallback below would return (see {@link resolveAgentCallRequest}).
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
  if (isAgentCallContext(context)) {
    return resolveAgentCallRequest(context);
  }

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
    // Normalize the names a context may carry, so a guard reads `headers` unconditionally:
    // `graphql-ws` gets them from CoreModule's onConnect, a custom onConnect may set `headers` itself,
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
