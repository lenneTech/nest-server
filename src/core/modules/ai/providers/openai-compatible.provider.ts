import { BadGatewayException, Logger, ServiceUnavailableException } from '@nestjs/common';

import {
  ILlmProvider,
  LlmCapabilities,
  LlmCompletionOptions,
  LlmMessage,
  LlmResponse,
  LlmToolSchema,
} from '../interfaces/llm-provider.interface';
import { ResolvedAiConnection } from '../interfaces/resolved-ai-connection.interface';

/**
 * Provider for OpenAI-compatible chat-completions endpoints.
 *
 * Works with any backend that speaks the OpenAI chat-completions shape — local
 * runtimes or hosted endpoints alike. Implemented with the native `fetch` API so
 * the framework core stays dependency-free and vendor-neutral.
 *
 * Capabilities are taken from the connection config (the admin knows what the
 * endpoint supports). The orchestrator compensates: when `nativeTools` is false it
 * emulates tool calling via the system prompt; when `jsonResponse` is false it
 * relies on prompt-instructed JSON. Both are off by default (the safe, lowest
 * common denominator) and can be enabled per connection.
 */
export class OpenAiCompatibleProvider implements ILlmProvider {
  readonly capabilities: LlmCapabilities;
  readonly name = 'openai-compatible';

  private readonly logger = new Logger(OpenAiCompatibleProvider.name);
  private readonly defaultTimeoutMs: number;

  constructor(private readonly connection: ResolvedAiConnection) {
    this.capabilities = {
      jsonResponse: connection.supportsJsonResponse ?? false,
      nativeTools: connection.supportsNativeTools ?? false,
      systemPrompt: true,
    };
    // Default to 2 minutes for interactive prompts; overridable per connection.
    this.defaultTimeoutMs = connection.timeoutMs ?? 120_000;
  }

  async chat(messages: LlmMessage[], tools: LlmToolSchema[], options?: LlmCompletionOptions): Promise<LlmResponse> {
    const url = `${this.connection.baseUrl.replace(/\/$/, '')}/chat/completions`;
    if (!url.startsWith('http')) {
      throw new ServiceUnavailableException(`AI connection "${this.connection.name}" has no valid baseUrl`);
    }

    const body: Record<string, any> = {
      max_tokens: options?.maxTokens ?? this.connection.defaultMaxTokens ?? 2048,
      messages: messages.map((m) => ({
        // Map the emulated 'tool' role to 'user' for backends that only know
        // system/user/assistant.
        content: m.content,
        role: m.role === 'tool' ? 'user' : m.role,
      })),
      model: options?.model ?? this.connection.model,
      stream: false,
      temperature: options?.temperature ?? this.connection.defaultTemperature ?? 0.1,
    };

    // Attach native parameters only when the backend supports them.
    if (this.capabilities.nativeTools && tools.length) {
      body.tools = tools.map((t) => ({
        function: { description: t.description, name: t.name, parameters: t.parameters },
        type: 'function',
      }));
    }
    if (this.capabilities.jsonResponse) {
      body.response_format = { type: 'json_object' };
    }

    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    let response: Response;
    try {
      response = await fetch(url, {
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${this.connection.apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const message = (err as Error)?.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : (err as Error).message;
      throw new ServiceUnavailableException(`AI request to "${this.connection.name}" failed: ${message}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.logger.warn(`AI completion failed (${response.status}) at ${url}: ${text.slice(0, 300)}`);
      throw new BadGatewayException(`AI completion via "${this.connection.name}" failed (HTTP ${response.status})`);
    }

    const result = (await response.json()) as {
      choices?: { message?: { content?: string; tool_calls?: any[] } }[];
      usage?: { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number };
    };

    const choice = result.choices?.[0]?.message;
    const text = choice?.content ?? '';
    const nativeToolCalls = this.capabilities.nativeTools ? this.mapNativeToolCalls(choice?.tool_calls) : undefined;

    return {
      raw: result,
      text,
      toolCalls: nativeToolCalls,
      usage: {
        completionTokens: result.usage?.completion_tokens,
        promptTokens: result.usage?.prompt_tokens,
        totalTokens: result.usage?.total_tokens,
      },
    };
  }

  /**
   * Map native `tool_calls` to the normalized {@link LlmResponse.toolCalls}.
   */
  private mapNativeToolCalls(toolCalls: any[] | undefined) {
    if (!toolCalls?.length) {
      return undefined;
    }
    return toolCalls
      .filter((c) => c?.function?.name)
      .map((c) => {
        let parsedArgs: Record<string, any> = {};
        try {
          parsedArgs = c.function.arguments ? JSON.parse(c.function.arguments) : {};
        } catch {
          parsedArgs = {};
        }
        return { arguments: parsedArgs, id: c.id, name: c.function.name };
      });
  }
}
