import { BadGatewayException, Logger, ServiceUnavailableException } from '@nestjs/common';

import {
  ILlmProvider,
  LlmCompletionOptions,
  LlmMessage,
  LlmResponse,
  LlmToolSchema,
} from '../interfaces/llm-provider.interface';
import { ResolvedAiConnection } from '../interfaces/resolved-ai-connection.interface';

/**
 * Provider for OpenAI-compatible chat-completions endpoints.
 *
 * Used for mittwald AI hosting (https://llm.aihosting.mittwald.de/v1) and any
 * other OpenAI-compatible gateway (Azure OpenAI, vLLM, LiteLLM, Ollama's
 * `/v1` shim, …). Implemented with the native `fetch` API so the framework core
 * stays dependency-free and vendor-mode friendly.
 *
 * ## Tool calling
 *
 * mittwald's gateway does NOT support native function/tool calling or JSON mode,
 * so {@link supportsNativeTools} is `false`. Tool calling is emulated by the
 * orchestrator ({@link CoreAiService}) via the system prompt; this provider only
 * performs plain text completions. The flag is constructor-injectable so a
 * gateway that DOES support `tools` can be wired up without a new class.
 */
export class OpenAiCompatibleProvider implements ILlmProvider {
  readonly name = 'openai-compatible';
  readonly supportsNativeTools: boolean;

  private readonly logger = new Logger(OpenAiCompatibleProvider.name);
  private readonly defaultTimeoutMs: number;

  constructor(
    private readonly connection: ResolvedAiConnection,
    options?: { supportsNativeTools?: boolean },
  ) {
    // mittwald and most lightweight gateways do not support native tools → default false.
    this.supportsNativeTools = options?.supportsNativeTools ?? false;
    // mittwald allows up to 1,800s; default to 2 minutes for interactive prompts.
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
        // mittwald only knows system/user/assistant — map the emulated 'tool' role to 'user'.
        content: m.content,
        role: m.role === 'tool' ? 'user' : m.role,
      })),
      model: options?.model ?? this.connection.model,
      stream: false,
      temperature: options?.temperature ?? this.connection.defaultTemperature ?? 0.1,
    };

    // Only attach the native tools parameter when the backend actually supports it.
    if (this.supportsNativeTools && tools.length) {
      body.tools = tools.map((t) => ({
        function: { description: t.description, name: t.name, parameters: t.parameters },
        type: 'function',
      }));
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
      // 401/403 = config error, 429 = rate limit, 5xx = transient — surface status for the caller.
      this.logger.warn(`AI completion failed (${response.status}) at ${url}: ${text.slice(0, 300)}`);
      throw new BadGatewayException(`AI completion via "${this.connection.name}" failed (HTTP ${response.status})`);
    }

    const result = (await response.json()) as {
      choices?: { message?: { content?: string; tool_calls?: any[] } }[];
      usage?: { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number };
    };

    const choice = result.choices?.[0]?.message;
    const text = choice?.content ?? '';
    const nativeToolCalls = this.supportsNativeTools ? this.mapNativeToolCalls(choice?.tool_calls) : undefined;

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
   * Map OpenAI native `tool_calls` to the normalized {@link LlmResponse.toolCalls}.
   * Only relevant when {@link supportsNativeTools} is enabled.
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
