import { Logger } from '@nestjs/common';

import { ConfigService } from '../../../common/services/config.service.js';
import type { AiToolAuthorization, AiToolContext, IAiTool } from '../interfaces/ai-tool.interface.js';

const logger = new Logger('AiToolAuthorization');

/**
 * Runs a tool's `authorize()` for one call. Shared by the chat orchestrator (auto and plan mode) and the MCP
 * endpoint, so a data-level check holds on every path a tool is executed on (12.3.0+).
 *
 * Fails closed: a thrown `authorize()`, a missing answer or an `allowed` that is not exactly `true` is a refusal. The
 * error itself is logged, never handed to the model or the MCP client, because it may name records or internals.
 * A tool without `authorize()` is allowed — the registry role filter has already decided that the user may see it.
 */
export async function authorizeToolCall(
  tool: IAiTool,
  args: Record<string, any>,
  context: AiToolContext,
): Promise<AiToolAuthorization> {
  if (!tool.authorize) {
    return { allowed: true };
  }
  try {
    const result = await tool.authorize(args, context);
    if (typeof result === 'boolean') {
      return { allowed: result };
    }
    if (!result || typeof result !== 'object') {
      return { allowed: false };
    }
    return { ...result, allowed: result.allowed === true };
  } catch (err) {
    logger.warn(`authorize() of AI tool "${tool.name}" threw, call refused: ${(err as Error).message}`);
    return { allowed: false, reason: 'The authorization check for this action failed.' };
  }
}

/**
 * Whether a call of this tool needs the user's confirmation before it runs: a `destructive` tool always, a
 * `mutating` tool as the `ai.confirmation.mutating` policy says (`enforced`, else the caller's `requireConfirmation`,
 * else `default`), any other tool never.
 *
 * `requireConfirmation` is the chat client's per-prompt wish; the MCP endpoint passes none, so there the policy's
 * `default` decides.
 */
export function toolRequiresConfirmation(tool: IAiTool, requireConfirmation?: boolean): boolean {
  if (tool.destructive) {
    return true;
  }
  if (!tool.mutating) {
    return false;
  }
  const cfg = ConfigService.get<{ default?: boolean; enabled?: boolean; enforced?: boolean }>(
    'ai.confirmation.mutating',
  );
  if (cfg?.enforced === true) {
    return true;
  }
  return requireConfirmation ?? cfg?.default === true;
}

/**
 * The server's MCP confirmation policy, from `ai.mcp.confirmation` (12.3.0+): `default` is whether MCP asks a user
 * who has not chosen for themselves, `enforced` whether users may choose at all.
 */
export interface AiMcpConfirmationPolicy {
  default: boolean;
  enforced: boolean;
}

/**
 * Reads `ai.mcp.confirmation`: `false` → asks nobody unless a user switches it on; `true`, `{}`, unset or any other
 * value → asks everybody unless a user switches it off; `{ default, enforced }` as written. Only `false` switches the
 * default off and only `true` enforces, so a misspelt value never relaxes the gate.
 */
export function mcpConfirmationPolicy(): AiMcpConfirmationPolicy {
  const mcp = ConfigService.get<unknown>('ai.mcp');
  const setting = mcp && typeof mcp === 'object' ? (mcp as { confirmation?: unknown }).confirmation : undefined;
  if (setting === false) {
    return { default: false, enforced: false };
  }
  if (setting && typeof setting === 'object') {
    const { default: defaultValue, enforced } = setting as { default?: unknown; enforced?: unknown };
    return { default: defaultValue !== false, enforced: enforced === true };
  }
  return { default: true, enforced: false };
}

/**
 * Whether MCP asks a user before a tool that needs confirmation: the user's own choice, unless the policy is
 * enforced or the user has not chosen.
 */
export function effectiveMcpConfirmation(policy: AiMcpConfirmationPolicy, userChoice?: boolean | null): boolean {
  if (policy.enforced || typeof userChoice !== 'boolean') {
    return policy.default;
  }
  return userChoice;
}
