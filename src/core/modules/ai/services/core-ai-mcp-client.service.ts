import { Injectable, Logger } from '@nestjs/common';

import { RoleEnum } from '../../../common/enums/role.enum';
import { AiToolContext, AiToolResult, IAiTool } from '../interfaces/ai-tool.interface';
import { AiToolRegistry } from '../tools/ai-tool.registry';

/**
 * The MCP-client side of `@modelcontextprotocol/sdk` that we need to talk to. Kept
 * structurally compatible so projects can pass either the real SDK `Client` or a
 * test double / lightweight wrapper.
 */
export interface McpLikeClient {
  callTool(req: { arguments?: Record<string, any>; name: string }): Promise<{ content?: { text?: string; type?: string }[]; isError?: boolean }>;
  close?(): Promise<void> | void;
  listTools(): Promise<{ tools: { description?: string; inputSchema?: any; name: string }[] }>;
}

/**
 * Configuration of an external MCP server we connect to as a client.
 */
export interface AiMcpClientConfig {
  /** Connected MCP client instance. Use `client` to pass a ready-made client (recommended). */
  client?: McpLikeClient;
  /** Roles required to see the imported tools. @default [S_USER] */
  defaultRoles?: (RoleEnum | string)[];
  /** Logical name; becomes the namespace prefix `<name>_<tool>` for imported tools. */
  name: string;
}

/**
 * Wires an external MCP server into our {@link AiToolRegistry}: lists the server's
 * tools and registers each one as a wrapper tool that calls back to the MCP
 * client's `callTool`. Imported tools are namespaced as `<clientName>_<toolName>`
 * (avoids collisions across clients and with locally registered tools).
 *
 * The wrapper passes the original AiToolContext to the registry filter so role
 * gating still applies — but the underlying CALL goes to the external server,
 * whose own security model also applies. By default we mark imported tools as
 * `mutating: true` (conservative) — they require confirmation. A project can
 * override `defaultRoles` / mutating flag via the config.
 *
 * Override this class for project-specific connection logic (stdio spawn /
 * StreamableHTTP / SSE / OAuth) via `CoreModule.forRoot(env, { ai: { mcpClientService } })`.
 */
@Injectable()
export class CoreAiMcpClientService {
  protected readonly logger = new Logger(CoreAiMcpClientService.name);
  protected readonly registered = new Map<string, { client: McpLikeClient; toolNames: string[] }>();

  constructor(protected readonly registry: AiToolRegistry) {}

  /**
   * Discover the external server's tools and register each one as a namespaced
   * wrapper in the global tool registry. Idempotent on `name` — re-registers if
   * called again with the same name (drops the previous tools first).
   */
  async registerExternalClient(config: AiMcpClientConfig): Promise<string[]> {
    if (!config?.name || !config?.client) {
      throw new Error('McpClientService.registerExternalClient requires { name, client }');
    }
    // Drop previous registration under this name.
    await this.unregisterExternalClient(config.name);

    let discovered: { tools: { description?: string; inputSchema?: any; name: string }[] };
    try {
      discovered = await config.client.listTools();
    } catch (err) {
      this.logger.warn(`MCP listTools for "${config.name}" failed: ${(err as Error).message}`);
      return [];
    }

    const registered: string[] = [];
    for (const t of discovered?.tools || []) {
      if (!t?.name) {
        continue;
      }
      const ns = `${config.name}_${t.name}`;
      const wrapper: IAiTool = this.buildWrapperTool(ns, t, config);
      this.registry.register(wrapper);
      registered.push(ns);
    }
    this.registered.set(config.name, { client: config.client, toolNames: registered });
    if (registered.length) {
      this.logger.log(`Registered ${registered.length} tool(s) from MCP client "${config.name}": ${registered.join(', ')}`);
    }
    return registered;
  }

  /** Tear down a previously registered MCP client and remove its tools. */
  async unregisterExternalClient(name: string): Promise<void> {
    const entry = this.registered.get(name);
    if (!entry) {
      return;
    }
    for (const toolName of entry.toolNames) {
      try {
        this.registry.unregister(toolName);
      } catch {
        // best-effort
      }
    }
    try {
      await entry.client.close?.();
    } catch {
      // best-effort
    }
    this.registered.delete(name);
  }

  /** Build the IAiTool wrapper for one imported MCP tool. */
  protected buildWrapperTool(
    namespacedName: string,
    descriptor: { description?: string; inputSchema?: any; name: string },
    config: AiMcpClientConfig,
  ): IAiTool {
    const client = config.client!;
    const tool: IAiTool = {
      description: descriptor.description || `(External MCP tool from "${config.name}")`,
      // Conservative default for external tools — they require confirmation until
      // the project explicitly opts out via a hook or scoped policy.
      mutating: true,
      name: namespacedName,
      parameters: descriptor.inputSchema || { properties: {}, type: 'object' },
      roles: config.defaultRoles || [RoleEnum.S_USER],
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      execute: async (args: Record<string, any>, _context: AiToolContext): Promise<AiToolResult> => {
        try {
          const res = await client.callTool({ arguments: args ?? {}, name: descriptor.name });
          if (res?.isError) {
            return {
              message: this.extractText(res) || `MCP tool "${descriptor.name}" reported an error.`,
              success: false,
            };
          }
          const text = this.extractText(res);
          let data: unknown = text;
          if (text) {
            try {
              data = JSON.parse(text);
            } catch {
              // keep raw text
            }
          }
          return { data, success: true };
        } catch (err) {
          return { message: (err as Error).message, success: false };
        }
      },
    };
    return tool;
  }

  /** Concatenate text parts of an MCP tool result. */
  protected extractText(res: { content?: { text?: string; type?: string }[] } | undefined): string {
    if (!res?.content?.length) {
      return '';
    }
    return res.content
      .filter((p) => p?.text)
      .map((p) => p.text!)
      .join('\n')
      .trim();
  }
}
