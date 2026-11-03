import { Injectable, Logger, Optional } from '@nestjs/common';

import { RequestContext } from '../../../common/services/request-context.service.js';
import {
  authorizeToolCall,
  effectiveMcpConfirmation,
  mcpConfirmationPolicy,
  toolRequiresConfirmation,
} from '../helpers/ai-tool-authorization.helper.js';
import { AiToolContext, IAiTool } from '../interfaces/ai-tool.interface.js';
import { AiToolRegistry, AiToolUser } from '../tools/ai-tool.registry.js';
import type { AiToolPolicyDecision } from './core-ai-tool-policy.service.js';
import { CoreAiToolPolicyService } from './core-ai-tool-policy.service.js';
import { CoreAiUserSettingService } from './core-ai-user-setting.service.js';

/**
 * MCP tool descriptor (name + description + JSON-schema input + behaviour hints).
 */
export interface McpToolDescriptor {
  /**
   * MCP tool annotations for a tool that declares what it does: `destructive` → `destructiveHint: true`,
   * `mutating` → `destructiveHint: false`, both with `readOnlyHint: false`. Absent for a tool with neither flag:
   * such a tool may still write (the flags used to matter for the chat only), so it is never advertised as
   * read-only and clients keep the spec's cautious defaults. Hints for the client's own confirmation UI, never a
   * security boundary — the server enforces `authorize()` and its confirmation gate itself.
   */
  annotations?: { destructiveHint: boolean; readOnlyHint: boolean };
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
 * The question put to the user before a tool that needs confirmation runs over MCP.
 */
export interface McpConfirmationPrompt {
  /** The arguments the tool will run with. */
  arguments: Record<string, any>;
  /** The text the MCP client shows the user. */
  message: string;
  /** The tool's name. */
  tool: string;
}

/**
 * Options of {@link CoreAiMcpService.mcpCallTool}.
 */
export interface McpCallToolOptions {
  /**
   * Asks the user to confirm the call; resolves `true` only when they did. `createServer()` passes one that uses MCP
   * elicitation when the client supports it. Absent: the client cannot ask, so a call that needs confirmation is
   * refused.
   */
  confirm?: (prompt: McpConfirmationPrompt) => Promise<boolean>;
}

/**
 * Exposes the {@link AiToolRegistry} as a Model Context Protocol (MCP) server so
 * external MCP clients (e.g. desktop MCP clients) can use the same backend tools with
 * the same role gating as the internal orchestrator.
 *
 * The MCP server is created per session and bound to the authenticating user, so
 * `tools/list` and `tools/call` are filtered to that user's permitted tools and
 * executed with their permissions (via each tool's `execute()` → CrudService).
 *
 * Since 12.3.0 `tools/call` also applies the gates of the chat orchestrator: the admin's tool policies (`deny`
 * refuses, `ask` asks), the tool's `authorize()`, and the confirmation of a `destructive` tool (or a `mutating` one
 * under `ai.confirmation.mutating`) through MCP elicitation. Whether MCP asks is `ai.mcp.confirmation` (on by default),
 * which each user may switch for themselves (`PUT /ai/settings`) unless the server enforces it.
 *
 * The `@modelcontextprotocol/sdk` is imported lazily in {@link createServer} so it
 * is only loaded when MCP is actually enabled — keeping the core lean.
 */
@Injectable()
export class CoreAiMcpService {
  protected readonly logger = new Logger(CoreAiMcpService.name);

  /** How long the server waits for the user's answer to a confirmation request. */
  protected readonly confirmationTimeoutMs = 5 * 60_000;

  constructor(
    protected readonly toolRegistry: AiToolRegistry,
    @Optional() protected readonly userSettingService?: CoreAiUserSettingService,
    @Optional() protected readonly toolPolicyService?: CoreAiToolPolicyService,
  ) {}

  /**
   * List the MCP tool descriptors the user is allowed to use.
   */
  mcpListTools(user: AiToolUser | null | undefined): McpToolDescriptor[] {
    return this.toolRegistry.forUser(user).map((tool) => ({
      ...(tool.destructive || tool.mutating
        ? { annotations: { destructiveHint: tool.destructive === true, readOnlyHint: false } }
        : {}),
      description: tool.description,
      inputSchema: tool.parameters,
      name: tool.name,
    }));
  }

  /**
   * Execute an MCP tool call with the user's permissions. Returns an MCP content
   * result; unknown/forbidden tools, a refused `authorize()`, a missing confirmation and
   * execution errors yield `isError: true`.
   */
  async mcpCallTool(
    user: AiToolUser | null | undefined,
    name: string,
    args: Record<string, any>,
    options: McpCallToolOptions = {},
  ): Promise<McpCallResult> {
    const tool = this.toolRegistry.forUser(user).find((t) => t.name === name);
    if (!tool) {
      return this.errorResult(`Unknown or not permitted tool: ${name}`);
    }
    const callArgs = args ?? {};
    const context: AiToolContext = {
      currentUser: (user ?? undefined) as AiToolContext['currentUser'],
      serviceOptions: { currentUser: (user ?? undefined) as AiToolContext['currentUser'] },
    };

    const policy = await this.evaluateToolPolicy(tool, callArgs, user);
    if (policy?.decision === 'deny') {
      return this.errorResult(policy.reason || `"${name}" is not permitted by policy.`);
    }
    const authorization = await authorizeToolCall(tool, callArgs, context);
    if (!authorization.allowed) {
      return this.errorResult(authorization.reason || `Not permitted: ${name}`);
    }
    if (policy?.decision === 'ask' || (await this.confirmationRequired(tool, user))) {
      if (!options.confirm) {
        return this.errorResult(
          `"${name}" needs the user's confirmation, and this MCP client cannot ask for it (elicitation). Nothing was run.`,
        );
      }
      if (!(await this.askForConfirmation(tool, callArgs, options.confirm))) {
        return this.errorResult(`"${name}" was not run: the user did not confirm it.`);
      }
    }

    try {
      const result = await tool.execute(callArgs, tool.authorize ? { ...context, authorization } : context);
      return { content: [{ text: JSON.stringify(result), type: 'text' }] };
    } catch (err) {
      this.logger.warn(`MCP tool "${name}" failed: ${(err as Error).message}`);
      return this.errorResult((err as Error).message);
    }
  }

  /**
   * Create a low-level MCP server bound to a user. Uses the JSON-schema tool
   * definitions directly (no zod conversion needed). The SDK is imported lazily.
   *
   * Pass a GETTER rather than a user object: an MCP session stays open for hours, and every
   * `tools/list` / `tools/call` must use the user's CURRENT rights — a role revoked after
   * `initialize` must not survive in the session. `CoreAiMcpController` passes a getter it refreshes
   * on every request (11.42.0+). A plain object is still accepted and is then fixed for the session.
   */
  async createServer(user: AiToolUser | (() => AiToolUser)): Promise<any> {
    const currentUser = (): AiToolUser => (typeof user === 'function' ? user() : user);
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

    // Loosely typed to decouple from the SDK's strict request/result types.
    const server: any = new Server({ name: 'lt-nest-server-ai', version: '1.0.0' }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.mcpListTools(currentUser()) }));
    server.setRequestHandler(CallToolRequestSchema, async (request: any, extra: any) =>
      this.mcpCallTool(currentUser(), request.params.name, request.params.arguments ?? {}, {
        // The SDK reads an empty `elicitation: {}` as form elicitation, the kind a yes/no question needs.
        confirm: server.getClientCapabilities()?.elicitation?.form
          ? (prompt: McpConfirmationPrompt) => this.elicitConfirmation(server, prompt, extra?.requestId)
          : undefined,
      }),
    );

    return server;
  }

  /**
   * Whether this call must be confirmed by the user: a tool that needs confirmation ({@link toolRequiresConfirmation},
   * with `ai.confirmation.mutating`'s default for `mutating`), while MCP asks this user — `ai.mcp.confirmation`, or the
   * user's own choice where the server allows one. An admin's `ask` policy is decided before and asks regardless.
   */
  protected async confirmationRequired(tool: IAiTool, user: AiToolUser | null | undefined): Promise<boolean> {
    if (!toolRequiresConfirmation(tool)) {
      return false;
    }
    if (this.userSettingService) {
      return this.userSettingService.mcpConfirmationFor(user?.id);
    }
    return effectiveMcpConfirmation(mcpConfirmationPolicy());
  }

  /**
   * The admin's tool policy for this call (`aiToolPolicies`), as the chat orchestrator evaluates it. `undefined`
   * without the policy service, without a matching rule, or when the evaluation fails (logged).
   */
  protected async evaluateToolPolicy(
    tool: IAiTool,
    args: Record<string, any>,
    user: AiToolUser | null | undefined,
  ): Promise<AiToolPolicyDecision | undefined> {
    if (!this.toolPolicyService) {
      return undefined;
    }
    try {
      return await this.toolPolicyService.evaluate(tool.name, args, {
        roles: (user?.roles as string[]) ?? [],
        tenantId: RequestContext.getTenantId(),
        userId: user?.id,
      });
    } catch (err) {
      this.logger.warn(`AI tool-policy evaluation for "${tool.name}" failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * The question shown to the user. English, because an MCP request carries no language; override to localize.
   *
   * Every argument gets a line of its own and only its value is shortened: the arguments come from the model, and
   * a cut over the whole text would let a long first value push the one that decides the outcome (the target id)
   * out of the question the user approves.
   */
  protected confirmationPrompt(tool: IAiTool, args: Record<string, any>): McpConfirmationPrompt {
    const maxValueLength = 200;
    const lines = Object.entries(args).map(([key, value]) => {
      const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
      const shown =
        text.length > maxValueLength ? `${text.slice(0, maxValueLength)}… (${text.length} characters)` : text;
      return `- ${key}: ${shown}`;
    });
    const consequence = tool.destructive ? 'This cannot be undone.' : 'This changes data.';
    const argumentsText = lines.length ? `\nArguments:\n${lines.join('\n')}` : '';
    return {
      arguments: args,
      message: `Allow the AI assistant to run "${tool.name}"? ${consequence}${argumentsText}`,
      tool: tool.name,
    };
  }

  /**
   * Puts the question to the user. Anything but an explicit yes — a no, a cancelled dialog, an error, a timeout —
   * counts as "not confirmed".
   */
  protected async askForConfirmation(
    tool: IAiTool,
    args: Record<string, any>,
    confirm: NonNullable<McpCallToolOptions['confirm']>,
  ): Promise<boolean> {
    try {
      return (await confirm(this.confirmationPrompt(tool, args))) === true;
    } catch (err) {
      this.logger.warn(`Confirmation of MCP tool "${tool.name}" failed, not run: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Asks through MCP form elicitation, as part of the running `tools/call` request (`relatedRequestId`), so a
   * Streamable HTTP client receives the question on that request's stream.
   */
  protected async elicitConfirmation(server: any, prompt: McpConfirmationPrompt, requestId: unknown): Promise<boolean> {
    const result = await server.elicitInput(
      {
        message: prompt.message,
        requestedSchema: {
          properties: {
            confirm: { description: `Run "${prompt.tool}" now`, title: 'Confirm', type: 'boolean' },
          },
          required: ['confirm'],
          type: 'object',
        },
      },
      { relatedRequestId: requestId, timeout: this.confirmationTimeoutMs },
    );
    return result?.action === 'accept' && result.content?.confirm === true;
  }

  /** An MCP error result with one text block. */
  protected errorResult(text: string): McpCallResult {
    return { content: [{ text, type: 'text' }], isError: true };
  }
}
