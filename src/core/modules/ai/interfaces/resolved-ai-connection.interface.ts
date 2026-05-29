/**
 * A fully resolved AI connection ready to instantiate a provider.
 *
 * This is the runtime shape produced by {@link CoreAiConnectionService.resolve}
 * after reading the persisted {@link CoreAiConnection} and decrypting its API
 * key. It is system-internal and MUST NOT be returned to clients (it carries the
 * plaintext API key).
 */
export interface ResolvedAiConnection {
  /** Plaintext API key (decrypted or read from the env fallback). May be empty for keyless local backends. */
  apiKey: string;

  /** Base URL of the OpenAI-compatible endpoint (e.g. 'https://llm.example.com/v1'). */
  baseUrl: string;

  /** Total context window (input + output tokens) the model supports, if known. */
  contextWindow?: number;

  /** Default maximum number of tokens for completions. */
  defaultMaxTokens?: number;

  /** Default sampling temperature. */
  defaultTemperature?: number;

  /**
   * Provider-side soft user quota (tokens) over {@link defaultUserMaxPeriod}.
   * Used as a fallback in the budget summary when no user / tenant hard limit
   * is configured.
   */
  defaultUserMaxTokens?: number;

  /** Period for {@link defaultUserMaxTokens} (`day` | `month` | `none`). */
  defaultUserMaxPeriod?: string;

  /** Connection id (for audit/logging). */
  id: string;

  /** Model id sent to the backend (e.g. 'gpt-oss-120b'). */
  model: string;

  /** Human-readable connection name. */
  name: string;

  /** Provider implementation key (e.g. 'openai-compatible'). */
  providerType: string;

  /** Whether the backend natively supports JSON/structured-output mode. */
  supportsJsonResponse?: boolean;

  /** Whether the backend natively supports function/tool calling. */
  supportsNativeTools?: boolean;

  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}
