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
   * Build the full system prompt for a run.
   *
   * @param tools Tools available to the current user.
   * @param supportsNativeTools Whether the provider handles tool calling natively.
   */
  buildSystemPrompt(tools: IAiTool[], supportsNativeTools: boolean): string {
    const base = ConfigService.get<string>('ai.systemPrompt') || this.defaultSystemPrompt;

    // With native tool calling the protocol is handled by the provider, so we
    // only ship the base prompt. Without it, we describe the emulation protocol.
    if (supportsNativeTools || tools.length === 0) {
      return base;
    }

    return `${base}\n\n${this.buildToolProtocol(tools)}`;
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
