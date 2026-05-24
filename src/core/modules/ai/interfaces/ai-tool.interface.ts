import { RoleEnum } from '../../../common/enums/role.enum';
import { ServiceOptions } from '../../../common/interfaces/service-options.interface';

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

  /** Accept-Language of the original request. */
  language?: string;

  /**
   * ServiceOptions to forward to downstream services. Contains `currentUser`,
   * so authorization, field filtering and tenant context are preserved.
   */
  serviceOptions: ServiceOptions;
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

  /** Unique tool name (snake_case recommended, stable across versions). */
  readonly name: string;

  /** JSON schema of the tool's input arguments (OpenAI/JSON-schema shape). */
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
