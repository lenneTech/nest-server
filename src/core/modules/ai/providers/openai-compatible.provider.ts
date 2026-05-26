import { BadGatewayException, Logger, ServiceUnavailableException } from '@nestjs/common';

import { ConfigService } from '../../../common/services/config.service';
import { ErrorCode } from '../../error-code';
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

  /**
   * Send a chat completion request to the OpenAI-compatible `/chat/completions`
   * endpoint and map the response to {@link LlmResponse}. Sends native `tools` and
   * `response_format` only when the connection's capabilities allow it; native tool
   * calls are mapped via {@link mapNativeToolCalls}. Aborts after the connection's
   * timeout and maps HTTP/transport errors to a {@link ServiceUnavailableException}.
   */
  async chat(messages: LlmMessage[], tools: LlmToolSchema[], options?: LlmCompletionOptions): Promise<LlmResponse> {
    const url = `${this.connection.baseUrl.replace(/\/$/, '')}/chat/completions`;
    if (!url.startsWith('http')) {
      this.logger.warn(`AI connection "${this.connection.name}" has no valid baseUrl: ${this.connection.baseUrl}`);
      throw new ServiceUnavailableException(ErrorCode.AI_CONNECTION_INVALID_URL);
    }
    this.assertBaseUrlAllowed(url);

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
      this.logger.warn(`AI request to "${this.connection.name}" failed: ${message}`);
      throw new ServiceUnavailableException(ErrorCode.AI_PROVIDER_ERROR);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.logger.warn(`AI completion failed (${response.status}) at ${url}: ${text.slice(0, 300)}`);
      throw new BadGatewayException(ErrorCode.AI_PROVIDER_ERROR);
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
   * Optional SSRF hardening: when `ai.allowedBaseUrlHosts` is configured (non-empty),
   * only allow requests to those hosts (matched by `host` incl. port, or bare
   * `hostname`). Unset → permissive (so local providers like Ollama on localhost work
   * out of the box). `baseUrl` is admin-only, so this guards a compromised/misconfigured
   * admin, not an end-user input.
   */
  protected assertBaseUrlAllowed(url: string): void {
    const allowedHosts = ConfigService.get<string[]>('ai.allowedBaseUrlHosts');
    if (!Array.isArray(allowedHosts) || !allowedHosts.length) {
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ServiceUnavailableException(ErrorCode.AI_CONNECTION_INVALID_URL);
    }
    if (!allowedHosts.includes(parsed.host) && !allowedHosts.includes(parsed.hostname)) {
      this.logger.warn(
        `AI connection "${this.connection.name}" host "${parsed.host}" is not in ai.allowedBaseUrlHosts`,
      );
      throw new ServiceUnavailableException(ErrorCode.AI_CONNECTION_NOT_AVAILABLE);
    }
  }

  /**
   * Probe the backend to auto-detect capabilities for flags the connection left
   * undefined. Explicit flags are authoritative and are NOT probed. Best effort:
   * - JSON: send `response_format: json_object`; 2xx → true, 4xx → false.
   * - Native tools: send a trivial tool with `tool_choice: 'required'`; 2xx WITH a
   *   `tool_calls` result → true, otherwise → false (a backend that silently ignores
   *   tools returns no tool_calls and is treated as unsupported).
   *
   * Throws on a transport error so callers can treat the connection as undetected
   * (and retry later) rather than persisting a wrong value.
   */
  async detectCapabilities(): Promise<{ jsonResponse?: boolean; nativeTools?: boolean }> {
    const result: { jsonResponse?: boolean; nativeTools?: boolean } = {};
    if (this.connection.supportsJsonResponse === undefined) {
      const res = await this.probe({
        max_tokens: 8,
        messages: [{ content: 'Reply with the JSON object {"ok":true}.', role: 'user' }],
        response_format: { type: 'json_object' },
      });
      result.jsonResponse = res.ok;
    }
    if (this.connection.supportsNativeTools === undefined) {
      const res = await this.probe({
        max_tokens: 8,
        messages: [{ content: 'Call the ping tool.', role: 'user' }],
        tool_choice: 'required',
        tools: [
          {
            function: {
              description: 'A no-op capability probe.',
              name: 'ping',
              parameters: { properties: {}, type: 'object' },
            },
            type: 'function',
          },
        ],
      });
      result.nativeTools = res.ok && !!res.json?.choices?.[0]?.message?.tool_calls?.length;
    }
    return result;
  }

  /**
   * Send a minimal probe request and report whether the endpoint accepted it.
   * `ok` is true only for a 2xx response; a 4xx (feature unsupported) yields false.
   */
  protected async probe(extra: Record<string, any>): Promise<{ json?: any; ok: boolean }> {
    const url = `${this.connection.baseUrl.replace(/\/$/, '')}/chat/completions`;
    if (!url.startsWith('http')) {
      throw new ServiceUnavailableException(ErrorCode.AI_CONNECTION_INVALID_URL);
    }
    this.assertBaseUrlAllowed(url);
    const response = await fetch(url, {
      body: JSON.stringify({ model: this.connection.model, ...extra }),
      headers: { Authorization: `Bearer ${this.connection.apiKey}`, 'Content-Type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(this.connection.timeoutMs ?? 30_000),
    });
    if (!response.ok) {
      return { ok: false };
    }
    const json = await response.json().catch(() => undefined);
    return { json, ok: true };
  }

  /**
   * Determine the model's total context window automatically: first an Ollama
   * `/api/show` probe (local runtimes expose `<arch>.context_length`), then a
   * known-model heuristic table. Best effort — returns undefined when unknown.
   */
  async detectContextWindow(): Promise<number | undefined> {
    const fromBackend = await this.probeContextWindow().catch(() => undefined);
    return fromBackend ?? this.knownContextWindow(this.connection.model);
  }

  /**
   * Heuristic context window (tokens) for well-known model families, matched by
   * case-insensitive substrings of the model id. Override/extend for custom models.
   */
  protected knownContextWindow(model: string | undefined): number | undefined {
    const m = (model || '').toLowerCase();
    const table: [number, string[]][] = [
      [1_000_000, ['gemini-1.5', 'gemini-2']],
      [200_000, ['claude']],
      [
        128_000,
        ['gpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'o1', 'o3', 'gpt-oss', 'mistral-large', 'mistral-small3', 'command-r'],
      ],
      [131_072, ['qwen2.5', 'qwen3', 'llama-3.1', 'llama3.1', 'llama-3.3', 'llama3.3']],
      [65_536, ['mixtral']],
      [32_768, ['qwen2', 'mistral', 'gemma2', 'gemma-2']],
      [16_385, ['gpt-3.5']],
      [8_192, ['llama3', 'llama-3', 'gemma']],
    ];
    for (const [window, keys] of table) {
      if (keys.some((k) => m.includes(k))) {
        return window;
      }
    }
    return undefined;
  }

  /**
   * Probe a local Ollama backend for the model's context length via `/api/show`.
   * Returns undefined for non-Ollama endpoints or on any error.
   */
  protected async probeContextWindow(): Promise<number | undefined> {
    const base = this.connection.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
    if (!base.startsWith('http')) {
      return undefined;
    }
    const response = await fetch(`${base}/api/show`, {
      body: JSON.stringify({ name: this.connection.model }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(this.connection.timeoutMs ?? 15_000),
    }).catch(() => undefined);
    if (!response?.ok) {
      return undefined;
    }
    const json = (await response.json().catch(() => undefined)) as { model_info?: Record<string, unknown> } | undefined;
    const info = json?.model_info;
    if (!info) {
      return undefined;
    }
    const key = Object.keys(info).find((k) => k.endsWith('.context_length'));
    const value = key ? info[key] : undefined;
    return typeof value === 'number' && value > 0 ? value : undefined;
  }

  /**
   * Map native `tool_calls` to the normalized {@link LlmResponse.toolCalls}.
   */
  protected mapNativeToolCalls(toolCalls: any[] | undefined) {
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
