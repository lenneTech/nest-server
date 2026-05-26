import { Injectable, Logger } from '@nestjs/common';

import { AiHookEvent, AiHookPreDecision, IAiHook } from '../interfaces/ai-hook.interface';
import { IAiTool } from '../interfaces/ai-tool.interface';
import { CoreAiResponse } from '../models/core-ai-response.model';

/**
 * Global registry of AI lifecycle hooks (PreToolUse / PostToolUse / SessionStart /
 * Stop). Hooks are dispatched in registration order — the first PreToolUse hook
 * returning `{ block: true }` aborts the tool call.
 *
 * Hooks register themselves on module init (via the {@link AiHookBase} base
 * class). Override or override the dispatch order by extending this registry and
 * supplying it through `CoreModule.forRoot(env, { ai: { hookRegistry } })`.
 */
@Injectable()
export class AiHookRegistry {
  private readonly hooks: IAiHook[] = [];
  private readonly logger = new Logger(AiHookRegistry.name);

  /** Register a hook. Idempotent on `name`. */
  register(hook: IAiHook): void {
    if (!hook?.name) {
      return;
    }
    if (this.hooks.some((h) => h.name === hook.name)) {
      return;
    }
    this.hooks.push(hook);
    this.logger.debug(`Registered AI hook: ${hook.name}`);
  }

  /** All registered hooks, in registration order. */
  list(): IAiHook[] {
    return [...this.hooks];
  }

  /**
   * Run every `preToolUse` hook against a tool call. Returns the first blocking
   * decision (or one with an `args` override). Errors are swallowed and logged.
   */
  async runPreToolUse(
    call: { arguments: Record<string, any>; name: string },
    tool: IAiTool,
    event: AiHookEvent,
  ): Promise<AiHookPreDecision> {
    let merged: AiHookPreDecision = {};
    for (const hook of this.hooks) {
      if (!hook.preToolUse) {
        continue;
      }
      try {
        const decision = await hook.preToolUse(call, tool, event);
        if (!decision) {
          continue;
        }
        if (decision.args) {
          // Each subsequent hook sees the rewritten args (chained sanitization).
          call.arguments = decision.args;
          merged.args = decision.args;
        }
        if (decision.block) {
          merged = { ...merged, block: true, reason: decision.reason || merged.reason };
          break;
        }
      } catch (err) {
        this.logger.warn(`AI hook "${hook.name}" preToolUse error (ignored): ${(err as Error).message}`);
      }
    }
    return merged;
  }

  /** Notify all `postToolUse` hooks. Errors are swallowed. */
  async runPostToolUse(
    call: { arguments: Record<string, any>; name: string },
    tool: IAiTool,
    result: { result: unknown; success: boolean },
    event: AiHookEvent,
  ): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.postToolUse) {
        continue;
      }
      try {
        await hook.postToolUse(call, tool, result, event);
      } catch (err) {
        this.logger.warn(`AI hook "${hook.name}" postToolUse error (ignored): ${(err as Error).message}`);
      }
    }
  }

  /** Notify all `sessionStart` hooks. */
  async runSessionStart(event: AiHookEvent): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.sessionStart) {
        continue;
      }
      try {
        await hook.sessionStart(event);
      } catch (err) {
        this.logger.warn(`AI hook "${hook.name}" sessionStart error (ignored): ${(err as Error).message}`);
      }
    }
  }

  /** Notify all `stop` hooks. */
  async runStop(response: CoreAiResponse, event: AiHookEvent): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.stop) {
        continue;
      }
      try {
        await hook.stop(response, event);
      } catch (err) {
        this.logger.warn(`AI hook "${hook.name}" stop error (ignored): ${(err as Error).message}`);
      }
    }
  }
}
