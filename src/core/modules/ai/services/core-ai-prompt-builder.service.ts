import { Injectable } from '@nestjs/common';

import { ConfigService } from '../../../common/services/config.service';
import { IAiTool } from '../interfaces/ai-tool.interface';
import { LlmToolSchema } from '../interfaces/llm-provider.interface';

/**
 * Builds the system prompt and tool catalog for a prompt run.
 *
 * Separated from the orchestrator so projects can override prompt construction
 * (domain context, RAG, tone) by extending this class and passing it via
 * `CoreAiModule.forRoot({ promptBuilder })`.
 */
@Injectable()
export class CoreAiPromptBuilderService {
  /**
   * Default base system prompt (used when `ai.systemPrompt` is not configured).
   */
  protected readonly defaultSystemPrompt =
    'You are a helpful assistant integrated into a business application. ' +
    'Answer concisely and only use information you can obtain through the provided tools. ' +
    'Never invent data. If a request cannot be fulfilled with the available tools, say so.';

  /**
   * Build the full system prompt for a run, enriched with system documentation and
   * the current user's permissions (Goal #4: supply the LLM with the right info).
   *
   * @param tools Tools available to the current user.
   * @param supportsNativeTools Whether the provider handles tool calling natively.
   * @param user The current user (for the permissions section).
   */
  buildSystemPrompt(tools: IAiTool[], supportsNativeTools: boolean, user?: { id?: string; roles?: string[] }): string {
    const base = ConfigService.get<string>('ai.systemPrompt') || this.defaultSystemPrompt;
    const parts: string[] = [base];

    const documentation = this.getDocumentation();
    if (documentation) {
      parts.push(`\nSystem documentation:\n${documentation}`);
    }

    parts.push(`\n${this.buildPermissionsSection(user, tools)}`);

    // With native tool calling the protocol is handled by the provider; otherwise
    // describe the emulation protocol (which also documents the tool API).
    if (!supportsNativeTools && tools.length > 0) {
      parts.push(`\n${this.buildToolProtocol(tools)}`);
    }

    return parts.join('\n');
  }

  /**
   * Optional system documentation injected into the system prompt. Reads
   * `ai.documentation` by default; override to supply RAG results / API docs.
   */
  protected getDocumentation(): string | undefined {
    return ConfigService.get<string>('ai.documentation') || undefined;
  }

  /**
   * Describe the current user's permissions and the tools they may use, so the
   * model only attempts actions the user is actually allowed to perform.
   */
  protected buildPermissionsSection(user: { roles?: string[] } | undefined, tools: IAiTool[]): string {
    const roles = user?.roles?.length ? user.roles.join(', ') : 'none';
    const toolNames = tools.map((t) => t.name).join(', ') || 'none';
    return [
      'Your permissions and capabilities:',
      `- roles: ${roles}`,
      `- available tools (you may ONLY use these): ${toolNames}`,
      'Never claim to perform an action you have no tool for, and never assume rights you do not have.',
    ].join('\n');
  }

  /**
   * Build the system prompt for plan mode: the model must return a COMPLETE
   * ordered plan of tool calls as JSON instead of executing tools step by step.
   */
  buildPlanSystemPrompt(tools: IAiTool[], user?: { id?: string; roles?: string[] }): string {
    const base = ConfigService.get<string>('ai.systemPrompt') || this.defaultSystemPrompt;
    const documentation = this.getDocumentation();
    const catalog = tools
      .map((t) => `- ${t.name}: ${t.description}\n  parameters (JSON schema): ${JSON.stringify(t.parameters)}`)
      .join('\n');

    return [
      base,
      ...(documentation ? ['', 'System documentation:', documentation] : []),
      '',
      this.buildPermissionsSection(user, tools),
      '',
      'Available tools:',
      catalog || '(none)',
      '',
      'PLAN MODE: Do NOT execute anything. Respond with ONLY a JSON object describing the',
      'COMPLETE ordered plan of tool calls needed to fulfil the request:',
      '{"plan":[{"name":"<tool_name>","arguments":{ ... }}],"summary":"<short summary>"}',
      'List every required step in order. If no tools are needed, return an empty plan array.',
      'Reply with valid JSON only — no prose, no markdown code fences.',
    ].join('\n');
  }

  /**
   * Map tools to native tool schemas (used only when the provider supports it).
   */
  buildToolSchemas(tools: IAiTool[]): LlmToolSchema[] {
    return tools.map((t) => ({ description: t.description, name: t.name, parameters: t.parameters }));
  }

  /**
   * Build the emulated tool-calling protocol section appended to the system
   * prompt for providers without native tool calling (e.g. mittwald).
   */
  protected buildToolProtocol(tools: IAiTool[]): string {
    const catalog = tools
      .map((t) => `- ${t.name}: ${t.description}\n  parameters (JSON schema): ${JSON.stringify(t.parameters)}`)
      .join('\n');

    return [
      'You can call backend tools to fetch or modify data. Available tools:',
      catalog,
      '',
      'To call tools, respond with ONLY a JSON object (no prose, no markdown code fences):',
      '{"tool_calls":[{"name":"<tool_name>","arguments":{ ... }}]}',
      'You may request multiple tools at once. You will then receive a message starting with',
      '"TOOL_RESULTS:" containing the results; use them to continue.',
      '',
      'When you have the final answer for the user, respond with ONLY a JSON object:',
      '{"final":"<your natural language answer>","data": <optional structured data or null>}',
      'Never mix tool_calls and final in the same response. Always reply with valid JSON only.',
    ].join('\n');
  }
}
