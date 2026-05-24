import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';

import { ServiceOptions } from '../../../common/interfaces/service-options.interface';
import { ConfigService } from '../../../common/services/config.service';
import { AiToolContext, AiToolResult, IAiTool } from '../interfaces/ai-tool.interface';
import { LlmMessage, LlmToolCall } from '../interfaces/llm-provider.interface';
import { CoreAiAction } from '../models/core-ai-action.model';
import { CoreAiResponse } from '../models/core-ai-response.model';
import { CoreAiUsage } from '../models/core-ai-usage.model';
import { CoreAiPromptInput } from '../inputs/core-ai-prompt.input';
import { LlmProviderFactory } from '../providers/llm-provider.factory';
import { AiToolRegistry } from '../tools/ai-tool.registry';
import { CoreAiConnectionService } from './core-ai-connection.service';
import { CoreAiPromptBuilderService } from './core-ai-prompt-builder.service';

/**
 * Record passed to {@link CoreAiService.audit} for each prompt run.
 */
export interface AiInteractionRecord {
  actions: { name: string; success: boolean }[];
  connectionId: string;
  iterations: number;
  prompt: string;
  responseText: string;
  userId?: string;
}

/**
 * Orchestrator for AI prompts — the agent loop that ties together the LLM
 * provider, the tool registry and the response shaping.
 *
 * Flow per prompt:
 * 1. rate-limit the user ({@link checkRateLimit})
 * 2. resolve the DB connection and build a provider
 * 3. filter tools by the user's roles (first-line authorization)
 * 4. loop: call the LLM, execute requested tools (with the user's permissions),
 *    feed results back, until a final answer or `maxIterations`
 * 5. shape the {@link CoreAiResponse} and audit the run
 *
 * Tool calling is emulated for providers without native support (mittwald):
 * the tool catalog is injected into the system prompt and tool calls are parsed
 * from the model's JSON output. Providers that support native tools are used
 * transparently.
 *
 * Override any `protected` method (or the whole service via
 * `CoreAiModule.forRoot({ service })`) to customize behaviour.
 */
@Injectable()
export class CoreAiService {
  protected readonly logger = new Logger(CoreAiService.name);

  /** In-memory rate-limit buckets keyed by user id. */
  private readonly rateBuckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    protected readonly connectionService: CoreAiConnectionService,
    protected readonly providerFactory: LlmProviderFactory,
    protected readonly toolRegistry: AiToolRegistry,
    protected readonly promptBuilder: CoreAiPromptBuilderService,
  ) {}

  /**
   * Run a prompt and return a structured response.
   */
  async prompt(input: CoreAiPromptInput, serviceOptions: ServiceOptions): Promise<CoreAiResponse> {
    const currentUser = serviceOptions?.currentUser;
    await this.checkRateLimit(currentUser?.id);

    const connection = await this.connectionService.resolve(input.connectionId);
    const provider = this.providerFactory.create(connection);

    // First-line authorization: only offer tools the user may use.
    const tools = this.toolRegistry.forUser(currentUser);

    // Only forward currentUser + language to tools (never the full serviceOptions).
    const context: AiToolContext = {
      currentUser,
      language: serviceOptions?.language,
      serviceOptions: { currentUser, language: serviceOptions?.language },
    };

    const systemPrompt = this.promptBuilder.buildSystemPrompt(tools, provider.supportsNativeTools);
    const toolSchemas = this.promptBuilder.buildToolSchemas(tools);

    const messages: LlmMessage[] = [{ content: systemPrompt, role: 'system' }];
    if (input.context) {
      messages.push({ content: `Context:\n${JSON.stringify(input.context)}`, role: 'user' });
    }
    messages.push({ content: input.prompt, role: 'user' });

    const maxIterations = ConfigService.get<number>('ai.maxIterations') ?? 5;
    const actions: CoreAiAction[] = [];
    const usage = { completionTokens: 0, promptTokens: 0, totalTokens: 0 };
    let finalText = '';
    let finalData: unknown;
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;
      const completion = await provider.chat(messages, toolSchemas, {
        maxTokens: connection.defaultMaxTokens,
        temperature: connection.defaultTemperature,
      });
      usage.completionTokens += completion.usage?.completionTokens ?? 0;
      usage.promptTokens += completion.usage?.promptTokens ?? 0;
      usage.totalTokens += completion.usage?.totalTokens ?? 0;

      const toolCalls = provider.supportsNativeTools ? completion.toolCalls : this.extractToolCalls(completion.text);

      if (toolCalls?.length) {
        messages.push({
          content: completion.text || JSON.stringify({ tool_calls: toolCalls }),
          role: 'assistant',
        });
        const results: { name: string; result: unknown; success: boolean }[] = [];
        for (const call of toolCalls) {
          const action = await this.executeToolCall(call, tools, context);
          actions.push(action);
          results.push({ name: action.name, result: action.result, success: action.success });
        }
        messages.push({ content: `TOOL_RESULTS:\n${JSON.stringify(results)}`, role: 'user' });
        continue;
      }

      // No tool calls → this is the final answer.
      const parsed = this.extractJsonObject(completion.text);
      if (parsed && typeof parsed.final === 'string') {
        finalText = parsed.final;
        finalData = parsed.data ?? undefined;
      } else {
        finalText = completion.text;
      }
      break;
    }

    if (!finalText) {
      finalText = 'I could not produce a final answer within the allowed number of steps.';
    }

    const response = new CoreAiResponse();
    response.actions = actions;
    response.connectionId = connection.id;
    response.conversationId = input.conversationId;
    response.data = finalData;
    response.iterations = iterations;
    response.text = finalText;
    response.usage = Object.assign(new CoreAiUsage(), usage);

    await this.audit({
      actions: actions.map((a) => ({ name: a.name, success: a.success })),
      connectionId: connection.id,
      iterations,
      prompt: input.prompt,
      responseText: finalText,
      userId: currentUser?.id,
    });

    return response;
  }

  // ===================================================================================================================
  // Overridable hooks
  // ===================================================================================================================

  /**
   * Persist/track a prompt run. Default implementation logs at debug level.
   * Override to write an audit collection.
   */
  protected async audit(record: AiInteractionRecord): Promise<void> {
    this.logger.debug(
      `AI prompt by ${record.userId ?? 'anonymous'} via ${record.connectionId}: ` +
        `${record.iterations} iteration(s), ${record.actions.length} action(s)`,
    );
  }

  /**
   * Simple in-memory sliding-window rate limit. Enabled when `ai.rateLimit` is
   * present (presence implies enabled). Override for distributed limiting.
   */
  protected async checkRateLimit(userId?: string): Promise<void> {
    const cfg = ConfigService.get<{ enabled?: boolean; max?: number; windowSeconds?: number }>('ai.rateLimit');
    if (!cfg || cfg.enabled === false) {
      return;
    }
    const max = cfg.max ?? 20;
    const windowMs = (cfg.windowSeconds ?? 60) * 1000;
    const key = userId || 'anonymous';
    const now = Date.now();

    let bucket = this.rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.rateBuckets.set(key, bucket);
    }
    bucket.count++;

    // Evict expired buckets when the map grows large (bounded memory).
    if (this.rateBuckets.size > 5000) {
      for (const [k, b] of this.rateBuckets) {
        if (b.resetAt <= now) {
          this.rateBuckets.delete(k);
        }
      }
    }

    if (bucket.count > max) {
      throw new HttpException('Too many AI requests, please slow down.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /**
   * Execute a single tool call with the user's permissions.
   */
  protected async executeToolCall(
    call: LlmToolCall,
    availableTools: IAiTool[],
    context: AiToolContext,
  ): Promise<CoreAiAction> {
    const action = new CoreAiAction();
    action.arguments = call.arguments;
    action.name = call.name;

    const tool = availableTools.find((t) => t.name === call.name);
    if (!tool) {
      action.success = false;
      action.result = { error: `Unknown or not permitted tool: ${call.name}` };
      return action;
    }

    try {
      const raw = await tool.execute(call.arguments ?? {}, context);
      let success = true;
      let payload: unknown = raw;
      if (raw && typeof raw === 'object' && 'success' in (raw as AiToolResult)) {
        const toolResult = raw as AiToolResult;
        success = toolResult.success !== false;
        payload = toolResult.data ?? toolResult.message ?? toolResult;
      }
      action.success = success;
      action.result = this.sanitizeResult(payload, context.currentUser);
    } catch (err) {
      this.logger.warn(`AI tool "${call.name}" failed: ${(err as Error).message}`);
      action.success = false;
      action.result = { error: (err as Error).message };
    }
    return action;
  }

  /**
   * Extract emulated tool calls from a text response, or `undefined` if none.
   */
  protected extractToolCalls(text: string): LlmToolCall[] | undefined {
    const parsed = this.extractJsonObject(text);
    if (parsed && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length) {
      return parsed.tool_calls
        .filter((c: any) => typeof c?.name === 'string')
        .map((c: any) => ({ arguments: c.arguments ?? {}, name: c.name }));
    }
    return undefined;
  }

  /**
   * Robustly extract a single JSON object from an LLM text response (tolerates
   * markdown code fences and surrounding prose).
   */
  protected extractJsonObject(text: string): any | null {
    if (!text) {
      return null;
    }
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
      t = fence[1].trim();
    }
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
      return null;
    }
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  /**
   * Defense-in-depth: run `securityCheck()` on any CoreModel instances before
   * their data is serialized into the LLM context. CrudService already filters
   * `@Restricted` fields, so this is belt-and-suspenders for tools that return
   * model instances.
   */
  protected sanitizeResult(value: unknown, user: AiToolContext['currentUser']): unknown {
    if (Array.isArray(value)) {
      return value.map((v) => this.sanitizeResult(v, user));
    }
    if (value && typeof (value as { securityCheck?: unknown }).securityCheck === 'function') {
      return (value as { securityCheck: (u: unknown) => unknown }).securityCheck(user);
    }
    return value;
  }
}
