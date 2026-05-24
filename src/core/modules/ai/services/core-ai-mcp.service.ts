import { Injectable, Logger } from '@nestjs/common';

import { AiToolContext } from '../interfaces/ai-tool.interface';
import { AiToolRegistry, AiToolUser } from '../tools/ai-tool.registry';

/**
 * MCP tool descriptor (name + description + JSON-schema input).
 */
export interface McpToolDescriptor {
  description: string;
  inputSchema: Record<string, any>;
  name: string;
}

/**
 * MCP tool-call result in the SDK content shape.
 */
export interface McpCallResult {
  content: { text: string; type: 'text' }[];
  isError?: boolean;
}

/**
 * Exposes the {@link AiToolRegistry} as a Model Context Protocol (MCP) server so
 * external MCP clients (e.g. Claude Desktop) can use the same backend tools with
 * the same role gating as the internal orchestrator.
 *
 * The MCP server is created per session and bound to the authenticating user, so
 * `tools/list` and `tools/call` are filtered to that user's permitted tools and
 * executed with their permissions (via each tool's `execute()` → CrudService).
 *
 * The `@modelcontextprotocol/sdk` is imported lazily in {@link createServer} so it
 * is only loaded when MCP is actually enabled — keeping the core lean.
 */
@Injectable()
export class CoreAiMcpService {
  protected readonly logger = new Logger(CoreAiMcpService.name);

  constructor(protected readonly toolRegistry: AiToolRegistry) {}

  /**
   * List the MCP tool descriptors the user is allowed to use.
   */
  mcpListTools(user: AiToolUser | null | undefined): McpToolDescriptor[] {
    return this.toolRegistry
      .forUser(user)
      .map((tool) => ({ description: tool.description, inputSchema: tool.parameters, name: tool.name }));
  }

  /**
   * Execute an MCP tool call with the user's permissions. Returns an MCP content
   * result; unknown/forbidden tools and execution errors yield `isError: true`.
   */
  async mcpCallTool(
    user: AiToolUser | null | undefined,
    name: string,
    args: Record<string, any>,
  ): Promise<McpCallResult> {
    const tool = this.toolRegistry.forUser(user).find((t) => t.name === name);
    if (!tool) {
      return { content: [{ text: `Unknown or not permitted tool: ${name}`, type: 'text' }], isError: true };
    }
    const context: AiToolContext = {
      currentUser: (user ?? undefined) as AiToolContext['currentUser'],
      serviceOptions: { currentUser: (user ?? undefined) as AiToolContext['currentUser'] },
    };
    try {
      const result = await tool.execute(args ?? {}, context);
      return { content: [{ text: JSON.stringify(result), type: 'text' }] };
    } catch (err) {
      this.logger.warn(`MCP tool "${name}" failed: ${(err as Error).message}`);
      return { content: [{ text: (err as Error).message, type: 'text' }], isError: true };
    }
  }

  /**
   * Create a low-level MCP server bound to a user. Uses the JSON-schema tool
   * definitions directly (no zod conversion needed). The SDK is imported lazily.
   */
  async createServer(user: AiToolUser): Promise<any> {
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

    // Loosely typed to decouple from the SDK's strict request/result types.
    const server: any = new Server({ name: 'lt-nest-server-ai', version: '1.0.0' }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.mcpListTools(user) }));
    server.setRequestHandler(CallToolRequestSchema, async (request: any) =>
      this.mcpCallTool(user, request.params.name, request.params.arguments ?? {}),
    );

    return server;
  }
}
