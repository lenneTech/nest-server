import { BadGatewayException, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { LanguageModel } from 'ai';

import { outboundFetch } from '../../../common/helpers/outbound-url.helper.js';
import { ErrorCode } from '../../error-code/index.js';
import {
  ILlmProvider,
  LlmAttachment,
  LlmCapabilities,
  LlmCompletionOptions,
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  LlmToolSchema,
  LlmUsage,
} from '../interfaces/llm-provider.interface.js';
import { ResolvedAiConnection } from '../interfaces/resolved-ai-connection.interface.js';
import { AiSdkPackageError, loadAiSdk, loadNestjsResilience } from './ai-sdk.packages.js';

/** Upper bound for an attachment the transport downloads itself (a model that cannot read the URL). */
export const AI_SDK_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Upper bound for all attachments one model call downloads together. */
export const AI_SDK_MAX_ATTACHMENT_BYTES_PER_CALL = 50 * 1024 * 1024;

/** Upper bound for the number of attachments one model call downloads. */
export const AI_SDK_MAX_ATTACHMENT_DOWNLOADS = 10;

/** What {@link readBodyWithLimit} reads: a web `ReadableStream` of bytes — the global one or undici's. */
export interface ByteStreamLike {
  getReader(): {
    cancel(reason?: unknown): Promise<void>;
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    releaseLock(): void;
  };
}

/**
 * Reads a response body chunk by chunk and stops — cancelling the stream — as soon as it passes `limit` bytes or the
 * call's shared `budget` runs out. Never trusts `Content-Length`: a chunked body has none, and a compressed one declares
 * the compressed size while `fetch` hands out the decompressed bytes. `arrayBuffer()` would hold all of it before any
 * check could run.
 */
export async function readBodyWithLimit(
  body: ByteStreamLike | null | undefined,
  limit: number,
  budget: { remaining: number } = { remaining: Number.POSITIVE_INFINITY },
): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      total += value.byteLength;
      budget.remaining -= value.byteLength;
      if (total > limit || budget.remaining < 0) {
        await reader.cancel().catch(() => undefined);
        throw new BadGatewayException('Attachment too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

/**
 * How an {@link AiSdkProvider} gets its model and runs a call.
 */
export interface AiSdkProviderOptions {
  /** Resolves the AI SDK `LanguageModel` — once per provider instance, on the first call. */
  model: () => LanguageModel | Promise<LanguageModel>;
  /**
   * `'nestjs'`: retries and timeout through `@nestjs/resilience` (connections of `providerType: 'nestjs-ai'`, whose
   * project installed it with `@nestjs/ai`). `'sdk'` (default): the AI SDK's own retries and a timeout signal — a project
   * that registered a model builder may have installed nothing but `ai` and a provider package.
   */
  resilience?: 'nestjs' | 'sdk';
}

/**
 * {@link ILlmProvider} over an AI SDK `LanguageModel` (nestjs-ai plan §2): any provider the AI SDK supports
 * (`@ai-sdk/anthropic`, `@ai-sdk/openai`, …) and every model registered in `@nestjs/ai`'s `AiModule.forRoot({ models })`.
 *
 * SECURITY: native tools are handed to the model WITHOUT `execute` — the AI SDK returns the model's tool calls and stops
 * after one step, and `CoreAiService` runs them through its own gates (role filter, tool policies and grants,
 * `authorize()`, confirmation, plan mode, budgets). Nothing here executes a tool.
 *
 * Attachments: an attachment URL the model cannot read itself is downloaded by the transport — through
 * `outboundFetch()`, the SSRF guard for user-entered URLs, never the AI SDK's own unguarded download — streamed, at most
 * {@link AI_SDK_MAX_ATTACHMENT_DOWNLOADS} per call, {@link AI_SDK_MAX_ATTACHMENT_BYTES} each and
 * {@link AI_SDK_MAX_ATTACHMENT_BYTES_PER_CALL} together. Usage feeds the budget and audit like the built-in provider's.
 */
export class AiSdkProvider implements ILlmProvider {
  readonly capabilities: LlmCapabilities;
  readonly name: string;

  protected readonly logger = new Logger(AiSdkProvider.name);
  protected modelPromise?: Promise<LanguageModel>;

  constructor(
    protected readonly connection: ResolvedAiConnection,
    protected readonly options: AiSdkProviderOptions,
  ) {
    this.name = `ai-sdk:${connection.providerType}`;
    this.capabilities = {
      jsonResponse: connection.supportsJsonResponse === true,
      // AI SDK providers speak native tool calling; a connection can still opt out explicitly
      nativeTools: connection.supportsNativeTools !== false,
      systemPrompt: true,
    };
  }

  async chat(messages: LlmMessage[], tools: LlmToolSchema[], options?: LlmCompletionOptions): Promise<LlmResponse> {
    const sdk = await loadAiSdk(
      `The AI connection "${this.connection.name}" (providerType "${this.connection.providerType}")`,
    );
    const model = await this.resolveModel();
    const timeoutMs = options?.timeoutMs ?? this.connection.timeoutMs ?? 120_000;
    const request = this.buildRequest(sdk, model, messages, tools, options);

    let result: any;
    try {
      result = await this.run((signal) => sdk.generateText({ ...request, abortSignal: signal }), timeoutMs, options);
    } catch (error) {
      throw this.toTransportError(error);
    }
    return this.mapResult(result);
  }

  /**
   * The options of one `generateText()` call. Native tools carry a description and a JSON schema — and never an
   * `execute`: without one the AI SDK returns the model's tool calls instead of running them, so every gate of
   * `CoreAiService` stays in charge. An override must keep it that way.
   */
  protected buildRequest(
    sdk: any,
    model: LanguageModel,
    messages: LlmMessage[],
    tools: LlmToolSchema[],
    options?: LlmCompletionOptions,
  ): Record<string, any> {
    const request: Record<string, any> = {
      experimental_download: (
        requests: Array<{ abortSignal?: AbortSignal; isUrlSupportedByModel: boolean; url: URL }>,
      ) => this.downloadAttachments(requests),
      maxOutputTokens: options?.maxTokens ?? this.connection.defaultMaxTokens ?? 2048,
      // Retries are this transport's (see run()), never a second layer inside the SDK on top of them
      maxRetries: this.options.resilience === 'nestjs' ? 0 : 2,
      messages: this.mapMessages(messages),
      model,
      temperature: options?.temperature ?? this.connection.defaultTemperature ?? 0.1,
    };
    const instructions = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .filter(Boolean)
      .join('\n\n');
    if (instructions) {
      request.instructions = instructions;
    }
    if (this.capabilities.nativeTools && tools.length) {
      request.tools = Object.fromEntries(
        tools.map((tool) => [
          tool.name,
          { description: tool.description, inputSchema: sdk.jsonSchema(tool.parameters ?? { type: 'object' }) },
        ]),
      );
    }
    if (this.capabilities.jsonResponse && options?.jsonResponse !== false && !request.tools && sdk.Output?.json) {
      request.output = sdk.Output.json();
    }
    return request;
  }

  /** The model, resolved once. A failure is not kept: the next call tries again. */
  protected resolveModel(): Promise<LanguageModel> {
    if (!this.modelPromise) {
      this.modelPromise = Promise.resolve()
        .then(() => this.options.model())
        .then((model) => {
          if (!model) {
            throw new AiSdkPackageError(
              `The AI connection "${this.connection.name}" resolved no AI SDK model for "${this.connection.model}".`,
            );
          }
          return model;
        });
      this.modelPromise.catch(() => (this.modelPromise = undefined));
    }
    return this.modelPromise;
  }

  /**
   * One model call with retries and a timeout per attempt. `'nestjs'` wraps it in `@nestjs/resilience` policies (three
   * attempts on what the provider marks retryable, then the timeout); `'sdk'` lets the AI SDK retry (`maxRetries: 2`)
   * under one timeout signal.
   */
  protected async run<T>(
    call: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    options?: LlmCompletionOptions,
  ): Promise<T> {
    const callerSignal = options?.abortSignal;
    if (this.options.resilience === 'nestjs') {
      const resilience = await loadNestjsResilience(
        `The AI connection "${this.connection.name}" (providerType "nestjs-ai")`,
      );
      const policy = resilience.ResiliencePolicy.wrap(
        new resilience.RetryPolicy({ attempts: 3, retryIf: (error: unknown) => isRetryableModelError(error) }),
        new resilience.TimeoutPolicy(timeoutMs),
      );
      return policy.execute(
        ({ signal }: { signal: AbortSignal }) => call(signal),
        callerSignal ? { signal: callerSignal } : undefined,
      );
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    return call(signal);
  }

  /**
   * Our messages as AI SDK model messages. System messages travel as `instructions`; the emulated `tool` role becomes a
   * user message (as on the OpenAI-compatible provider) — the loop carries tool results as text, not as SDK tool-result
   * parts tied to an id.
   */
  protected mapMessages(messages: LlmMessage[]): Array<Record<string, any>> {
    return messages
      .filter((message) => message.role !== 'system')
      .map((message) => {
        if (message.role === 'assistant') {
          return { content: message.content ?? '', role: 'assistant' };
        }
        const attachments = (message.attachments ?? []).map((attachment) => this.mapAttachment(attachment));
        const parts = attachments.filter(Boolean);
        if (!parts.length) {
          return { content: message.content ?? '', role: 'user' };
        }
        return {
          content: [...(message.content ? [{ text: message.content, type: 'text' }] : []), ...parts],
          role: 'user',
        };
      });
  }

  /** An attachment as an image or file part; `undefined` when it carries neither a URL nor a data URL. */
  protected mapAttachment(attachment: LlmAttachment): Record<string, any> | undefined {
    const mediaType = attachment.mimeType || 'application/octet-stream';
    let data: string | URL | undefined;
    if (attachment.dataUrl?.startsWith('data:')) {
      const comma = attachment.dataUrl.indexOf(',');
      data = comma > 0 ? attachment.dataUrl.slice(comma + 1) : undefined;
    } else if (attachment.url) {
      try {
        data = new URL(attachment.url);
      } catch {
        data = undefined;
      }
    }
    if (!data) {
      return undefined;
    }
    return mediaType.startsWith('image/')
      ? { image: data, mediaType, type: 'image' }
      : { data, filename: attachment.name, mediaType, type: 'file' };
  }

  /**
   * The AI SDK's download hook: a URL the model reads itself is left to the provider (`null`); every other one is
   * fetched through `outboundFetch()` — private and internal addresses refused, every redirect hop checked — and capped
   * at {@link AI_SDK_MAX_ATTACHMENT_BYTES}.
   */
  protected async downloadAttachments(
    requests: Array<{ abortSignal?: AbortSignal; isUrlSupportedByModel: boolean; url: URL }>,
  ): Promise<Array<null | { data: Uint8Array; mediaType: string | undefined }>> {
    const downloads = requests.filter((request) => !request.isUrlSupportedByModel);
    if (downloads.length > AI_SDK_MAX_ATTACHMENT_DOWNLOADS) {
      throw new BadGatewayException(
        `Too many attachments to download (${downloads.length}, at most ${AI_SDK_MAX_ATTACHMENT_DOWNLOADS})`,
      );
    }
    // One byte budget for the whole call, shared by the parallel downloads
    const budget = { remaining: AI_SDK_MAX_ATTACHMENT_BYTES_PER_CALL };
    return Promise.all(
      requests.map(async ({ abortSignal, isUrlSupportedByModel, url }) => {
        if (isUrlSupportedByModel) {
          return null;
        }
        const response = await outboundFetch(url.toString(), abortSignal ? { signal: abortSignal } : {});
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new BadGatewayException(`Attachment download failed with HTTP ${response.status}`);
        }
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > AI_SDK_MAX_ATTACHMENT_BYTES) {
          await response.body?.cancel().catch(() => undefined);
          throw new BadGatewayException('Attachment too large');
        }
        const data = await readBodyWithLimit(response.body, AI_SDK_MAX_ATTACHMENT_BYTES, budget);
        return { data, mediaType: response.headers.get('content-type') ?? undefined };
      }),
    );
  }

  /** The AI SDK result as our {@link LlmResponse}. */
  protected mapResult(result: any): LlmResponse {
    const toolCalls: LlmToolCall[] = (result?.toolCalls ?? [])
      .filter((call: any) => typeof call?.toolName === 'string')
      .map((call: any) => ({
        arguments: call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input : {},
        id: call.toolCallId,
        name: call.toolName,
      }));
    return {
      finishReason: typeof result?.finishReason === 'string' ? result.finishReason : result?.finishReason?.unified,
      raw: result?.response?.body,
      text: typeof result?.text === 'string' ? result.text : '',
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: mapAiSdkUsage(result?.totalUsage ?? result?.usage),
    };
  }

  /** An error of the call as the HTTP answer the built-in provider gives for the same failure. */
  protected toTransportError(error: unknown): Error {
    if (error instanceof AiSdkPackageError || error instanceof ServiceUnavailableException) {
      return error;
    }
    if (error instanceof BadGatewayException) {
      return error;
    }
    const message = (error as Error)?.message ?? String(error);
    this.logger.warn(`AI connection "${this.connection.name}" call failed: ${message}`);
    return new ServiceUnavailableException(ErrorCode.AI_CONNECTION_NOT_AVAILABLE);
  }
}

/** AI SDK usage as {@link LlmUsage}; `undefined` when the provider reported nothing. */
export function mapAiSdkUsage(usage: any): LlmUsage | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  const promptTokens = numberOrUndefined(usage.inputTokens);
  const completionTokens = numberOrUndefined(usage.outputTokens);
  const reasoningTokens = numberOrUndefined(usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens);
  const totalTokens =
    numberOrUndefined(usage.totalTokens) ??
    (promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined);
  if ([promptTokens, completionTokens, reasoningTokens, totalTokens].every((value) => value === undefined)) {
    return undefined;
  }
  return {
    ...(completionTokens !== undefined && { completionTokens }),
    ...(promptTokens !== undefined && { promptTokens }),
    ...(reasoningTokens !== undefined && { reasoningTokens }),
    ...(totalTokens !== undefined && { totalTokens }),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** What the provider marks retryable (408, 409, 429, 5xx, network) — the AI SDK's `APICallError.isRetryable`. */
export function isRetryableModelError(error: unknown): boolean {
  return (error as { isRetryable?: unknown })?.isRetryable === true;
}
