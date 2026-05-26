import type { AiToolContext, IAiTool } from './ai-tool.interface';
import type { CoreAiPromptInput } from '../inputs/core-ai-prompt.input';
import type { CoreAiResponse } from '../models/core-ai-response.model';

/**
 * Decision returned by a `preToolUse` hook. `block: true` aborts the tool call
 * with a translated error; `block: false` (or undefined) lets it run. Returning
 * `args` replaces the original tool arguments — useful for input sanitization or
 * PII redaction. Returning nothing is equivalent to `{ block: false }`.
 */
export interface AiHookPreDecision {
  /** Replace the tool arguments before execution. */
  args?: Record<string, any>;
  /** Block the tool call entirely. */
  block?: boolean;
  /** Human-readable reason for blocking — surfaced as the tool error. */
  reason?: string;
}

/**
 * Lifecycle event payload passed to all hook methods.
 */
export interface AiHookEvent {
  /** The full prompt input the orchestrator is running. */
  input: CoreAiPromptInput;
  /** The user context (currentUser, serviceOptions, language). */
  toolContext: AiToolContext;
}

/**
 * Lifecycle hook a project can register to observe or gate the agent loop without
 * forking the orchestrator. Hooks are dispatched in registration order; the first
 * hook returning `{ block: true }` aborts the tool call.
 *
 * Implement any subset of the methods. Register the hook as a NestJS provider that
 * extends {@link AiHookBase} — it self-registers in the global {@link AiHookRegistry}
 * on module init.
 *
 * **Security:** hooks can only ADD restrictions (block calls, redact args) — they
 * cannot relax the permission system. A hook returning no block does not bypass
 * `@Restricted`/`@Roles`/`authorize()`; those still apply.
 */
export interface IAiHook {
  /** Unique hook name (for diagnostics and deterministic ordering). */
  readonly name: string;

  /**
   * Called BEFORE a tool runs. Can block the call, modify the args, or just
   * observe (return undefined). Errors thrown here are swallowed — hooks are
   * best-effort and must not crash a prompt run.
   */
  preToolUse?(call: { arguments: Record<string, any>; name: string }, tool: IAiTool, event: AiHookEvent): Promise<AiHookPreDecision | undefined> | AiHookPreDecision | undefined;

  /**
   * Called AFTER a tool ran (success or failure). Pure notification — the result
   * is not modifiable. Useful for audit/webhook/metrics integration.
   */
  postToolUse?(
    call: { arguments: Record<string, any>; name: string },
    tool: IAiTool,
    result: { result: unknown; success: boolean },
    event: AiHookEvent,
  ): Promise<void> | void;

  /** Called at the start of a prompt run, before any LLM call. */
  sessionStart?(event: AiHookEvent): Promise<void> | void;

  /** Called at the end of a prompt run, with the final response (or partial state). */
  stop?(response: CoreAiResponse, event: AiHookEvent): Promise<void> | void;
}
