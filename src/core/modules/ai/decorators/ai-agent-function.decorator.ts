import { AI_AGENT_FUNCTION_METADATA } from '../core-ai.constants.js';
import type { AiToolAuthorization, AiToolContext } from '../interfaces/ai-tool.interface.js';

/**
 * The framework's extras for a `@nestjs/ai` agent function that the AI module offers as a tool
 * (`ai.agentFunctions`, nestjs-ai plan §3). Everything `@nestjs/ai` does not know: who may see the tool, whether it
 * changes data, and a data-level check before it runs.
 */
export interface IAiAgentFunctionOptions {
  /**
   * Data-level check before every execution, with the arguments that will run — exactly `IAiTool.authorize()`. Called
   * with `this` bound to the provider instance. Fail closed: a throw refuses.
   */
  authorize?: (
    args: Record<string, any>,
    context: AiToolContext,
  ) => AiToolAuthorization | boolean | Promise<AiToolAuthorization | boolean>;
  /** Always asks the user before running (`IAiTool.destructive`). */
  destructive?: boolean;
  /** Changes data (`IAiTool.mutating`): the confirmation policy applies. */
  mutating?: boolean;
  /**
   * Roles that may see and call the tool. Default: the method's `@Roles()` (merged with the class's), else `S_USER`.
   * The method's `@Roles()` is ALSO enforced by the application's guards when `@nestjs/ai` runs it.
   */
  roles?: string[];
}

/**
 * Stacks the framework's tool extras on a `@nestjs/ai` `@AgentFunction()` method:
 *
 * ```typescript
 * @AgentFunction({ name: 'cancel_order', description: 'Cancel an order', inputSchema: z.object({ id: z.string() }) })
 * @AiAgentFunction({ destructive: true })
 * @Roles(RoleEnum.S_USER)
 * cancel({ id }: { id: string }) { ... }
 * ```
 */
export function AiAgentFunction(options: IAiAgentFunctionOptions = {}): MethodDecorator {
  return (_target, _key, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(AI_AGENT_FUNCTION_METADATA, { ...options }, descriptor.value);
    return descriptor;
  };
}
