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
        content: this.mapMessageContent(m),
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
    // A per-request `model` overrides the connection's — but the capability flags
    // were probed against `connection.model` and persisted per CONNECTION, never
    // per model. Applying them to a different model asserts something that was
    // never measured: the endpoint may reject `response_format` for it, and the
    // caller sees a transport error where it expected an answer. Fall back to the
    // safe subset (prompt-driven JSON + defensive parsing) whenever the model the
    // request actually targets is not the one the probe ran against.
    // `options.jsonResponse === false` narrows this off for a single call — the way a
    // caller whose PROMPT asks for prose says so. It can only ever narrow: the flag
    // was measured against this connection, so no option may assert it where the
    // probe never ran.
    if (this.capabilities.jsonResponse && options?.jsonResponse !== false && body.model === this.connection.model) {
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
    const allowedHosts = this.resolveAllowedBaseUrlHosts();
    if (!allowedHosts.length) {
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ServiceUnavailableException(ErrorCode.AI_CONNECTION_INVALID_URL);
    }
    // A hostname entry stays host-wide (any port); the extra candidates only make an
    // operator who was MORE explicit than necessary succeed rather than fail. `URL.host`
    // omits the default port, so a conscientious `llm.example.com:443` entry would
    // otherwise never match `https://llm.example.com/` — a lockout whose only symptom is
    // a WARN and "the AI stopped working". Nothing here widens the set of reachable hosts.
    const defaultPort = parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '';
    const candidates = [parsed.host, parsed.hostname];
    if (defaultPort && parsed.host === parsed.hostname) {
      candidates.push(`${parsed.hostname}:${defaultPort}`);
    }
    if (!candidates.map((candidate) => this.normaliseHostEntry(candidate)).some((c) => allowedHosts.includes(c))) {
      this.logger.warn(
        `AI connection "${this.connection.name}" host "${parsed.host}" is not in ai.allowedBaseUrlHosts`,
      );
      throw new ServiceUnavailableException(ErrorCode.AI_CONNECTION_NOT_AVAILABLE);
    }
  }

  /**
   * Output budget for the native-tool probe.
   *
   * A reasoning model spends output tokens on its thinking phase BEFORE it emits
   * `tool_calls`. With a budget of a few tokens the endpoint answers `200` with
   * `finish_reason: 'length'` and no tool call at all — which the probe used to read
   * as "native tools unsupported", persisting a false negative that is never
   * re-probed and degrades the assistant to emulated tool calling for good.
   *
   * Measured against an OpenAI-compatible hosting endpoint on 2026-07-25
   * (`tool_choice: 'required'` plus a trivial `ping` tool, varying only
   * `max_tokens`):
   *
   * | model                    |  8 | 64 | 256 |
   * |--------------------------|----|----|-----|
   * | Ministral-3-14B-Instruct | ✅ | ✅ | ✅  |
   * | Mistral-Medium-3.5-128B  | ✅ | ✅ | ✅  |
   * | gpt-oss-120b             | ❌ | ✅ | ✅  |
   * | Qwen3.5-122B-A10B-FP8    | ❌ | ✅ | ✅  |
   * | Qwen3.6-35B-A3B-FP8      | ❌ | ❌ | ✅  |
   *
   * 256 covers every model tested and costs a few hundred tokens ONCE per
   * connection, which is nothing against the cost of the wrong flag.
   */
  protected static readonly NATIVE_TOOL_PROBE_MAX_TOKENS = 256;

  /**
   * Second and FINAL budget for the native-tool probe, used only when the first
   * attempt came back truncated.
   *
   * The retry has to be bounded, and the bound has to live here. An inconclusive
   * result leaves the capability `undefined`, `detectAndPersistCapabilities` only
   * persists booleans, and the orchestrator re-runs detection whenever a flag is
   * undefined — so "just leave it undetected and try again later" would fire one
   * extra upstream completion before EVERY user prompt, ahead of the rate limiter
   * and outside any budget accounting. Two attempts, then a definite answer.
   *
   * Returning `false` after a model failed to emit a tool call within 1024 output
   * tokens is not the false negative this fix exists to prevent: a model that needs
   * more than that before its first tool call cannot drive an agent loop usefully
   * anyway, and emulated tool calling is the correct fallback for it.
   */
  protected static readonly NATIVE_TOOL_PROBE_MAX_TOKENS_RETRY = 1024;

  /**
   * The configured egress allowlist as a lowercase array, whatever shape it has.
   *
   * A STRING is split as CSV rather than rejected, because `ai.allowedBaseUrlHosts`
   * is reachable through the framework's own `NSC__AI__ALLOWED_BASE_URL_HOSTS`
   * environment mapping: `getEnvironmentObject()` turns that variable into
   * `{ ai: { allowedBaseUrlHosts: '<string>' } }` and lodash `merge` assigns the
   * scalar straight over the configured array. A bare `!Array.isArray(...) -> return`
   * then reads it as "no allowlist configured" and skips the check entirely — so an
   * operator using the canonical `NSC__` spelling silently disables SSRF egress
   * control, with no log line and no error. A malformed security setting must be
   * interpreted or fail CLOSED, never fail open.
   *
   * Entries are lowercased because `URL.host` / `URL.hostname` always are; a
   * differently-cased entry would otherwise fail closed for no stated reason, and
   * the only symptom would be a WARN log plus "the AI stopped working".
   *
   * A value that is NEITHER an array nor a string carries no hostnames and cannot be
   * interpreted — `NSC__AI__ALLOWED_BASE_URL_HOSTS=0` coerces to a number, and
   * `NEST_SERVER_CONFIG` can deliver an object. Returning an empty list there is the
   * only honest answer, but it reopens egress while the operator believes the control
   * is on, so it is LOGGED every time rather than passed over in silence. That is the
   * difference between this and the documented unset-is-permissive default: unset is a
   * decision, a malformed value is an accident nobody is told about.
   */
  protected resolveAllowedBaseUrlHosts(): string[] {
    const configured = ConfigService.get<unknown>('ai.allowedBaseUrlHosts');
    if (configured === undefined || configured === null) {
      return [];
    }
    const entries = typeof configured === 'string' ? configured.split(',') : configured;
    if (!Array.isArray(entries)) {
      this.logger.error(
        `ai.allowedBaseUrlHosts is a ${typeof configured} and carries no hostnames — the SSRF egress ` +
          'allowlist is NOT active. Use an array or a comma-separated string.',
      );
      return [];
    }
    return entries.map((host) => this.normaliseHostEntry(String(host))).filter(Boolean);
  }

  /**
   * Lowercase, trim, and drop a fully-qualifying trailing dot.
   *
   * Applied to BOTH the allowlist entry and the URL being checked, so neither side can
   * win by spelling the same DNS name differently. `llm.example.com.` and
   * `llm.example.com` resolve identically, so treating them as different hosts only ever
   * produced a confusing refusal — never protection.
   */
  protected normaliseHostEntry(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/\.(?=$|:)/, '');
  }

  /**
   * Probe the backend to auto-detect capabilities for flags the connection left
   * undefined. Explicit flags are authoritative and are NOT probed. Best effort:
   * - JSON: send `response_format: json_object`; 2xx AND content that actually
   *   parses as JSON → true. A 2xx alone is not evidence — a backend that does not
   *   implement `response_format` simply ignores the field and answers normally.
   * - Native tools: send a trivial tool with `tool_choice: 'required'`; 2xx WITH a
   *   `tool_calls` result → true. A backend that answers fully but silently ignores
   *   the tools returns no tool_calls and IS a real negative. A response truncated
   *   by the token budget (`finish_reason: 'length'` without tool_calls) proves
   *   nothing, so it is retried ONCE with
   *   {@link NATIVE_TOOL_PROBE_MAX_TOKENS_RETRY}; a second truncation resolves to
   *   `false`.
   *
   * This method always returns a definite boolean for a flag it probed. That is
   * deliberate: an `undefined` result is not persisted by
   * `detectAndPersistCapabilities`, and the orchestrator re-runs detection whenever
   * a flag is undefined — so an endpoint that keeps truncating would trigger one
   * extra upstream completion before every user prompt, ahead of the rate limiter
   * and outside budget accounting.
   *
   * Throws on a transport error so callers can treat the connection as undetected
   * (and retry later) rather than persisting a wrong value.
   */
  async detectCapabilities(): Promise<{ jsonResponse?: boolean; nativeTools?: boolean }> {
    const needsJson = this.connection.supportsJsonResponse === undefined;
    const needsTools = this.connection.supportsNativeTools === undefined;
    // Independent upstream calls, so run them together. This matters more since both
    // probes gained a truncation retry: sequentially, a fresh connection can now cost
    // FOUR round trips before the user's own completion starts — and lazy detection
    // sits inline on the interactive prompt path.
    const [jsonResponse, nativeTools] = await Promise.all([
      needsJson ? this.probeJsonResponse() : Promise.resolve(undefined),
      needsTools ? this.probeNativeTools() : Promise.resolve(undefined),
    ]);
    const result: { jsonResponse?: boolean; nativeTools?: boolean } = {};
    if (needsJson) {
      result.jsonResponse = jsonResponse;
    }
    if (needsTools) {
      result.nativeTools = nativeTools;
    }
    return result;
  }

  /**
   * Probe structured-JSON support.
   *
   * A 2xx alone is NOT evidence: a backend that does not implement
   * `response_format` typically ignores the unknown field and answers normally, so
   * trusting the status code alone persists `supportsJsonResponse: true` for an
   * endpoint that never honours it — after which `chat()` sends `response_format`
   * on every single call. Like the native-tool flag this is written once and never
   * re-probed, so the wrong value is permanent.
   *
   * The response content must therefore actually parse as JSON. The budget matches
   * the tool probe for the same reason: a reasoning model needs room to get past
   * its thinking phase before it emits anything parseable — INCLUDING the tool
   * probe's retry on truncation, which this probe needs just as badly.
   *
   * Measured against an OpenAI-compatible hosting endpoint on 2026-09-03 (this
   * same probe, varying only `max_tokens`; the number is the completion tokens the
   * model actually spent):
   *
   * | model                         | 256          | 1024   |
   * |-------------------------------|--------------|--------|
   * | Ministral-3-14B-Instruct-2512 | ✅ 9         | —      |
   * | gpt-oss-120b                  | ✅ 88        | —      |
   * | Qwen3.6-35B-A3B-FP8           | ✅ 202       | —      |
   * | Mistral-Medium-3.5-128B       | ❌ truncated | ✅ 878 |
   * | Qwen3.5-122B-A10B-FP8         | ❌ truncated | ✅ 365 |
   *
   * TWO of five need the retry — so without it the probe records "structured JSON
   * unsupported" for an endpoint that demonstrably supports it.
   *
   * That false negative costs on two different paths, and the expensive one is the
   * quiet one. `detectAndPersistCapabilities` WRITES what the probe returns, and a
   * written flag is authoritative and never re-probed — so a fresh connection whose
   * flags are unset is pinned to the wrong `false` for good, silently falling back
   * to prompt-driven JSON. The loud path is the `ai.capabilityDriftCheck` boot
   * warning (`supportsJsonResponse declared true but the endpoint reports false`),
   * which merely reads as endpoint drift and sends the next reader hunting for one
   * — which is how this was found. Note the warning fires only where that
   * opt-in check is enabled, while the persisted flag is wrong everywhere.
   *
   * A COMPLETE answer that merely is not JSON stays a real negative: the endpoint
   * ignored `response_format`, and a larger budget cannot change that.
   */
  protected async probeJsonResponse(): Promise<boolean> {
    const budgets = [
      OpenAiCompatibleProvider.NATIVE_TOOL_PROBE_MAX_TOKENS,
      OpenAiCompatibleProvider.NATIVE_TOOL_PROBE_MAX_TOKENS_RETRY,
    ];

    for (const [attempt, maxTokens] of budgets.entries()) {
      const res = await this.probe({
        max_tokens: maxTokens,
        messages: [{ content: 'Reply with the JSON object {"ok":true}.', role: 'user' }],
        response_format: { type: 'json_object' },
      });
      if (!res.ok) {
        return false;
      }
      const choice = res.json?.choices?.[0];
      const content = choice?.message?.content;
      const truncated = choice?.finish_reason === 'length';
      if (typeof content === 'string' && content.trim()) {
        try {
          JSON.parse(content);
          return true;
        } catch {
          // A parse failure is only a REAL negative when the model finished on its
          // own terms. Truncation is the other reason JSON does not parse, and it
          // arrives in two shapes depending on how the model emits: a reasoning
          // model buffers behind its thinking phase and returns EMPTY content, while
          // one that streams directly returns a partial body like `{"ok":tr`. Both
          // are `finish_reason: 'length'`, and classifying the partial one here
          // instead of retrying reaches the exact false negative this ladder exists
          // to remove — just through the other door.
          if (!truncated) {
            this.logger.warn(
              `JSON-response probe for model "${this.connection.model}" returned non-JSON content — ` +
                'recording structured JSON as unsupported',
            );
            return false;
          }
        }
      } else if (!truncated) {
        // Empty content that finished on its own terms is a real negative.
        return false;
      }

      const isLastAttempt = attempt === budgets.length - 1;
      this.logger.warn(
        `JSON-response probe for model "${this.connection.model}" was truncated (finish_reason=length) at ` +
          `max_tokens=${maxTokens}` +
          (isLastAttempt
            ? ' on the final attempt — recording structured JSON as unsupported; a model that cannot emit a ' +
              'trivial JSON object within a usable output budget is better served by the prompt-driven fallback'
            : ' — retrying once with a larger budget'),
      );
    }

    return false;
  }

  /**
   * Run the native-tool probe, escalating the output budget once on truncation.
   * Extracted so the retry policy is overridable and testable on its own.
   */
  protected async probeNativeTools(): Promise<boolean> {
    const budgets = [
      OpenAiCompatibleProvider.NATIVE_TOOL_PROBE_MAX_TOKENS,
      OpenAiCompatibleProvider.NATIVE_TOOL_PROBE_MAX_TOKENS_RETRY,
    ];

    for (const [attempt, maxTokens] of budgets.entries()) {
      const res = await this.probe({
        max_tokens: maxTokens,
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
      const choice = res.json?.choices?.[0];

      if (res.ok && choice?.message?.tool_calls?.length) {
        return true;
      }
      // A non-2xx, or a complete answer without tool calls, is a REAL negative —
      // retrying with a bigger budget would not change it.
      if (!res.ok || choice?.finish_reason !== 'length') {
        return false;
      }

      const isLastAttempt = attempt === budgets.length - 1;
      this.logger.warn(
        `Native-tool probe for model "${this.connection.model}" was truncated (finish_reason=length) at ` +
          `max_tokens=${maxTokens}` +
          (isLastAttempt
            ? ' on the final attempt — recording native tools as unsupported; the model does not reach a tool ' +
              'call within a usable output budget, so emulated tool calling is the correct fallback'
            : ' — retrying once with a larger budget'),
      );
    }

    return false;
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
      // Two DIFFERENT gaps, both closed here (measured 2026-07-25 against an
      // OpenAI-compatible hosting endpoint; both models verified to accept >=163k
      // prompt tokens):
      //   - `mistral-medium` DID match the generic `mistral` -> 32768 entry below,
      //     capping a 256k model at an eighth of its window. It must therefore be
      //     matched before it -- this bucket is evaluated first.
      //   - `ministral` matched NOTHING at all: "ministral" does not contain the
      //     substring "mistral" (m-i-n-i-s-t-r-a-l), so it fell through the whole
      //     table to the conservative 8192 default.
      // Pinned one power of two below the verified capacity so the orchestrator
      // trims before the endpoint rejects.
      [131_072, ['qwen2.5', 'qwen3', 'llama-3.1', 'llama3.1', 'llama-3.3', 'llama3.3', 'ministral', 'mistral-medium']],
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
    // The third outbound path from the same admin-controlled baseUrl, and the one the
    // allowlist used to miss. It is NOT admin-only in practice: CoreAiService calls
    // detectAndPersistCapabilities() on an ordinary user prompt whenever contextWindow is
    // undefined, and it runs BEFORE checkRateLimit(). A guard applied to two of three
    // egress paths is not a guard. Throwing is right here — detectContextWindow() already
    // wraps this call, so a refusal degrades to "context window unknown".
    this.assertBaseUrlAllowed(`${base}/api/show`);
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
  /**
   * Map a (possibly multi-modal) LlmMessage to the OpenAI content shape:
   * - Plain text → `content: string` (unchanged).
   * - Text + attachments → `content: [{type:'text',text}, {type:'image_url',image_url:{...}}, ...]`
   * Files/PDFs with `dataUrl` are passed as `image_url` too — backends that don't
   * support vision will warn or ignore.
   */
  protected mapMessageContent(m: { attachments?: any[]; content: string }): any {
    if (!Array.isArray(m.attachments) || !m.attachments.length) {
      return m.content;
    }
    const parts: any[] = [];
    if (m.content) {
      parts.push({ text: m.content, type: 'text' });
    }
    for (const a of m.attachments) {
      const url = a?.url || a?.dataUrl;
      if (!url) {
        continue;
      }
      parts.push({ image_url: { url }, type: 'image_url' });
    }
    return parts.length ? parts : m.content;
  }

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
