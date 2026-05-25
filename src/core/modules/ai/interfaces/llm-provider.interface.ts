/**
 * Abstraction layer for Large Language Model (LLM) providers.
 *
 * A provider encapsulates the transport to an LLM backend — local runtimes or
 * hosted endpoints, with or without native tool/JSON support. The orchestrator
 * ({@link CoreAiService}) talks only to this interface, so backends can be
 * swapped or extended without touching the agent loop. Nothing here is tied to a
 * specific vendor.
 *
 * ## Capability gradations
 *
 * Backends differ in what they support. Providers therefore declare their
 * {@link LlmCapabilities}, and the orchestrator compensates across the whole
 * spectrum:
 * - `nativeTools: true`  → tool schemas are passed natively and `toolCalls` are
 *   read from the response.
 * - `nativeTools: false` → tool calling is emulated: the tool catalog is injected
 *   into the system prompt and a structured JSON block is parsed from the text.
 * - `jsonResponse: true` → a JSON/structured-output mode is requested; otherwise
 *   JSON is requested via the prompt and parsed defensively.
 */
export type LlmMessageRole = 'assistant' | 'system' | 'tool' | 'user';

/**
 * Capabilities a provider/backend supports. Used by the orchestrator to decide
 * between native and emulated handling, so every gradation is supported.
 */
export interface LlmCapabilities {
  /** Native JSON / structured-output mode (e.g. `response_format`). */
  jsonResponse: boolean;

  /** Native function/tool calling (the `tools` parameter). */
  nativeTools: boolean;

  /** Support for a `system` role message (true for virtually all backends). */
  systemPrompt: boolean;
}

/**
 * A single chat message exchanged with the LLM.
 */
export interface LlmMessage {
  /** Plain-text content of the message. */
  content: string;

  /** Author role of the message. */
  role: LlmMessageRole;
}

/**
 * JSON-schema description of a tool the LLM may call.
 */
export interface LlmToolSchema {
  /** Human-readable description used by the model to decide when to call the tool. */
  description: string;

  /** Unique tool name (snake_case recommended). */
  name: string;

  /** JSON schema of the tool's input arguments. */
  parameters: Record<string, any>;
}

/**
 * A tool invocation requested by the LLM.
 */
export interface LlmToolCall {
  /** Parsed arguments for the tool. */
  arguments: Record<string, any>;

  /** Optional provider-specific call id (used by native tool calling). */
  id?: string;

  /** Name of the tool to call. */
  name: string;
}

/**
 * Token usage reported by the provider (best effort).
 */
export interface LlmUsage {
  completionTokens?: number;
  promptTokens?: number;
  totalTokens?: number;
}

/**
 * Per-request completion options. Values fall back to the connection defaults
 * when omitted.
 */
export interface LlmCompletionOptions {
  /** Maximum number of tokens to generate. */
  maxTokens?: number;

  /** Overrides the model id of the resolved connection. */
  model?: string;

  /** Sampling temperature. */
  temperature?: number;

  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Normalized response of a single LLM completion.
 */
export interface LlmResponse {
  /** Raw provider payload (for debugging/audit, never sent to clients). */
  raw?: unknown;

  /** Natural-language text content of the response. */
  text: string;

  /** Tool calls (only populated when {@link ILlmProvider.supportsNativeTools} is true). */
  toolCalls?: LlmToolCall[];

  /** Token usage (best effort). */
  usage?: LlmUsage;
}

/**
 * Result of capability auto-detection. Only the probed (previously undefined)
 * flags are present; explicit flags are authoritative and never probed.
 */
export interface LlmDetectedCapabilities {
  /** Detected `response_format` / JSON-mode support, or undefined if not probed. */
  jsonResponse?: boolean;

  /** Detected native tool-calling support, or undefined if not probed. */
  nativeTools?: boolean;
}

/**
 * Provider abstraction. Implementations are created per request by the
 * {@link LlmProviderFactory} from a persisted {@link CoreAiConnection}.
 */
export interface ILlmProvider {
  /** Declared capabilities of the backend (drives native vs. emulated handling). */
  readonly capabilities: LlmCapabilities;

  /** Identifier of the provider implementation (e.g. 'openai-compatible'). */
  readonly name: string;

  /**
   * Run a chat completion.
   *
   * @param messages Conversation so far (system + user + assistant + tool).
   * @param tools Tool schemas the model may use (ignored when not supported).
   * @param options Per-request completion options.
   */
  chat(messages: LlmMessage[], tools: LlmToolSchema[], options?: LlmCompletionOptions): Promise<LlmResponse>;

  /**
   * Optionally probe the backend to auto-detect capabilities for connection flags
   * that were left undefined (provider-agnostic best effort). Implementations that
   * cannot probe simply omit this method. Should resolve only the undefined flags
   * and throw on a transport error so callers can treat the connection as undetected.
   */
  detectCapabilities?(): Promise<LlmDetectedCapabilities>;
}
