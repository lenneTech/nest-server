import { Injectable } from '@nestjs/common';

import { RoleEnum } from '../../../common/enums/role.enum';
import { AiToolContext, AiToolResult } from '../interfaces/ai-tool.interface';
import { AiTool } from './ai-tool.base';
import { AiToolRegistry } from './ai-tool.registry';

/**
 * Built-in **meta-tool** for the "deferred tool-schemas" mode
 * (`ai.deferToolSchemas: true`): the system prompt then contains only the tool
 * NAMES + short descriptions, not the full JSON-Schemas — which can drastically
 * cut the context cost when many tools are registered. The LLM uses this tool to
 * fetch the parameter schema for a specific tool BEFORE calling it.
 *
 * The result respects the caller's role visibility — only tools the user can use
 * are returned (defense in depth on top of the orchestrator's role filter).
 */
@Injectable()
export class SearchToolsAiTool extends AiTool {
  readonly description =
    'Search the available backend tools and fetch the parameter schema of a specific tool. Use this before calling a tool whose parameter schema you have not yet seen.';
  readonly name = 'search_tools';
  readonly parameters = {
    properties: {
      name: { description: 'The exact tool name to fetch the full schema for.', type: 'string' },
      query: {
        description: 'Optional substring matched against tool name and description (returns a short list).',
        type: 'string',
      },
    },
    type: 'object',
  };
  readonly roles = [RoleEnum.S_USER];

  constructor(registry: AiToolRegistry) {
    super(registry);
  }

  async execute(args: Record<string, any>, context: AiToolContext): Promise<AiToolResult> {
    const allowed = this.registry.forUser(context.currentUser);
    const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : '';
    const name = typeof args?.name === 'string' ? args.name.trim() : '';
    if (name) {
      const tool = allowed.find((t) => t.name === name);
      if (!tool) {
        return { message: `Tool "${name}" is not available to you.`, success: false };
      }
      return {
        data: {
          description: tool.description,
          mutating: !!tool.mutating,
          destructive: !!tool.destructive,
          name: tool.name,
          parameters: tool.parameters,
        },
        success: true,
      };
    }
    const matches = query
      ? allowed.filter((t) => t.name.toLowerCase().includes(query) || t.description.toLowerCase().includes(query))
      : allowed;
    return {
      data: matches.map((t) => ({ description: t.description, name: t.name })),
      success: true,
    };
  }
}
