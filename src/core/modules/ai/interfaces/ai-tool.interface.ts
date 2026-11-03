import { RoleEnum } from '../../../common/enums/role.enum.js';
import { ServiceOptions } from '../../../common/interfaces/service-options.interface.js';

/**
 * Execution context handed to a tool when the LLM invokes it.
 *
 * The {@link serviceOptions} carry the authenticated user, so tools that call a
 * {@link CrudService} run with the caller's permissions — the LLM can never
 * escalate beyond what the user is allowed to do.
 */
export interface AiToolContext {
  /** Authenticated user (shortcut for `serviceOptions.currentUser`). */
  currentUser?: { [key: string]: any; id: string; roles?: string[] };

  /**
   * The decision {@link IAiTool.authorize} returned for THIS call, handed to `execute()` (12.3.0+). Lets a tool reuse
   * what its check loaded (`data`) instead of loading it twice. Absent for a tool without `authorize()`.
   */
  authorization?: AiToolAuthorization;

  /** Accept-Language of the original request. Absent over MCP, which carries no request language. */
  language?: string;

  /**
   * ServiceOptions to forward to downstream services. Contains `currentUser`,
   * so authorization, field filtering and tenant context are preserved.
   */
  serviceOptions: ServiceOptions;
}

/**
 * Result of a tool's pre-flight authorization check ({@link IAiTool.authorize}).
 */
export interface AiToolAuthorization {
  /** Whether the user may run the tool with these arguments. Only `true` allows; anything else refuses. */
  allowed: boolean;

  /**
   * Whatever the check loaded and `execute()` may reuse (e.g. the record whose ownership it verified). Reaches
   * `execute()` as `context.authorization.data`; never sent to the model or the client.
   */
  data?: unknown;

  /**
   * Optional reason when not allowed. It reaches the model (chat) or the MCP client, so it must not name anything
   * the user may not know.
   */
  reason?: string;
}

/**
 * Normalized result of a tool execution that is fed back to the LLM.
 */
export interface AiToolResult {
  /** Structured payload returned to the model (and optionally the frontend). */
  data?: unknown;

  /** Optional human-readable message. */
  message?: string;

  /** Whether the tool ran successfully. */
  success: boolean;
}

/**
 * A backend capability the LLM may call — the "MCP-like" building block.
 *
 * Tools self-register in the global {@link AiToolRegistry} (typically from
 * `onModuleInit`), so projects can add or override tools from any module without
 * DI-scope constraints. Implement this interface directly or extend the
 * convenience base class {@link AiTool}.
 *
 * ## Security
 *
 * - {@link roles} is a first-line visibility filter: tools the user may not use
 *   are never even offered to the LLM.
 * - The TRUE authorization gate is {@link execute}: tools must route data access
 *   through a {@link CrudService} using `context.serviceOptions` so `@Restricted`,
 *   `securityCheck()` and field filtering still apply.
 */
export interface IAiTool {
  /** Description shown to the LLM — the primary signal for when to use the tool. */
  readonly description: string;

  /**
   * Whether the tool performs a destructive/irreversible action (delete, bulk
   * update, payment, …). Such a tool always needs the user's confirmation:
   *
   * - **Chat:** it is NOT executed until the prompt is re-sent with `confirm: true`;
   *   the first response lists it as `pendingActions` with `requiresConfirmation: true`.
   * - **MCP (12.3.0+):** `tools/call` asks the user through MCP elicitation and runs the
   *   tool only after they accepted. A client that cannot ask (no `elicitation`
   *   capability) gets a refusal. Whether MCP asks is `ai.mcp.confirmation` (on by
   *   default), which each user may switch for themselves unless it is enforced;
   *   `tools/list` marks the tool with `destructiveHint: true`.
   */
  readonly destructive?: boolean;

  /**
   * Whether the tool changes data (create/update/delete). Confirmation for
   * mutating tools is governed by the `ai.confirmation` policy (admin default,
   * optionally client-overridable, optionally enforced). `destructive` is the
   * stronger flag and always requires confirmation regardless of policy.
   *
   * Over MCP (12.3.0+) the same policy applies through elicitation, with the
   * policy's `default` in place of the chat client's `requireConfirmation`.
   */
  readonly mutating?: boolean;

  /**
   * Optional authorization check for one call. MUST NOT mutate anything — it only
   * decides whether the user may run the tool with these arguments (e.g. load the
   * target record and verify ownership).
   *
   * **Runs before every execution (12.3.0+)**: in auto mode, in plan mode (once for
   * the whole plan before any step runs, and again before each step) and over MCP. It
   * sees the arguments that will be executed, i.e. after the PreToolUse hooks. A refusal,
   * a thrown error or an `allowed` that is not `true` skips the call. Return `data` to
   * hand what the check loaded to `execute()` (`context.authorization.data`).
   *
   * Still route the data access in `execute()` through `CrudService` with
   * `context.serviceOptions`: `authorize()` decides whether to try, the service decides
   * what the user may read and write.
   *
   * When omitted, only the registry role filter applies.
   */
  authorize?(args: Record<string, any>, context: AiToolContext): Promise<AiToolAuthorization | boolean>;

  /** Unique tool name (snake_case recommended, stable across versions). */
  readonly name: string;

  /** JSON schema of the tool's input arguments (JSON-schema shape). */
  readonly parameters: Record<string, any>;

  /**
   * Roles required to see and run the tool. Use {@link RoleEnum.S_EVERYONE} for
   * public tools, {@link RoleEnum.S_USER} for any authenticated user, or real
   * roles (e.g. `RoleEnum.ADMIN`) for privileged tools.
   */
  readonly roles: (RoleEnum | string)[];

  /**
   * Execute the tool. MUST enforce real authorization by routing through a
   * service with `context.serviceOptions`.
   */
  execute(args: Record<string, any>, context: AiToolContext): Promise<AiToolResult | unknown>;
}
