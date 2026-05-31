import { Injectable, Optional } from '@nestjs/common';

import { ConfigService } from '../../../common/services/config.service';
import { IAiTool } from '../interfaces/ai-tool.interface';
import { LlmToolSchema } from '../interfaces/llm-provider.interface';
import { CoreAiPlaceholderRegistry } from './core-ai-placeholder.registry';
import { CoreAiPromptHintService } from './core-ai-prompt-hint.service';
import { CoreAiSlotService, getSystemDefaultSlots, ResolvedPromptFragment } from './core-ai-slot.service';

/** Options for a prompt build (locale for template/hint selection). */
export interface BuildPromptOptions {
  language?: string;
  /** Named agent mode (e.g. 'support', 'audit') — exposes as a `mode:<name>` scope to filter fragments. */
  mode?: string;
}

/**
 * Builds the system prompt and tool catalog for a prompt run.
 *
 * The prompt is assembled from keyed fragments: built-in {@link defaultFragments}
 * overlaid by admin-editable rows from {@link CoreAiSlotService}, plus
 * governed learned hints from {@link CoreAiPromptHintService}. Nothing is hard-coded
 * and unreachable — admins and the learning loop can adjust every fragment. Override
 * this class via `CoreModule.forRoot(env, { ai: { promptBuilder } })` for custom
 * composition (domain context, RAG, tone).
 *
 * Placeholders rendered at build time: `{{documentation}}`, `{{roles}}`, `{{tools}}`,
 * `{{toolCatalog}}`, `{{learnedHints}}`, `{{userId}}`.
 */
@Injectable()
export class CoreAiPromptBuilderService {
  /** Keys that belong only to the auto (step-by-step) execution mode. */
  protected readonly autoOnlyKeys = ['output_contract', 'plan_protocol', 'tool_catalog', 'tool_protocol_emulated'];

  /** Default base system prompt (used when `ai.systemPrompt` is not configured). */
  protected readonly defaultSystemPrompt =
    'You are a helpful assistant integrated into a business application. ' +
    'Answer concisely and only use information you can obtain through the provided tools. ' +
    'Never invent data. If a request cannot be fulfilled with the available tools, say so.';

  /** Keys that describe tool calling (skipped when the user has no tools). */
  protected readonly toolKeys = ['output_contract', 'plan_protocol', 'tool_catalog', 'tool_protocol_emulated'];

  constructor(
    @Optional() protected readonly templateService?: CoreAiSlotService,
    @Optional() protected readonly hintService?: CoreAiPromptHintService,
    @Optional() protected readonly placeholderRegistry?: CoreAiPlaceholderRegistry,
  ) {}

  /**
   * Build the full system prompt for an auto-mode run, assembled from the effective
   * prompt fragments (defaults + admin overrides) with placeholders rendered and
   * governed learned hints injected.
   */
  async buildSystemPrompt(
    tools: IAiTool[],
    supportsNativeTools: boolean,
    user?: { id?: string; roles?: string[] },
    options?: BuildPromptOptions,
  ): Promise<string> {
    const capability = supportsNativeTools ? 'native' : 'emulated';
    const fragments = await this.resolveFragments(
      capability,
      options?.language,
      this.computeScopes(tools, user, options),
    );
    const context = await this.renderContext(tools, user);
    return this.assemble(
      fragments.filter((f) => f.key !== 'plan_protocol'),
      context,
      tools.length,
    );
  }

  /**
   * Build the system prompt for plan mode: the model must return a COMPLETE ordered
   * plan of tool calls as JSON instead of executing step by step. Shares the base /
   * documentation / permissions / anti-hallucination / error / learned-hints fragments
   * and uses the `plan_protocol` fragment instead of the auto-mode tool protocol.
   */
  async buildPlanSystemPrompt(
    tools: IAiTool[],
    user?: { id?: string; roles?: string[] },
    options?: BuildPromptOptions,
  ): Promise<string> {
    const fragments = await this.resolveFragments(
      'emulated',
      options?.language,
      this.computeScopes(tools, user, options),
    );
    const context = await this.renderContext(tools, user);
    const planFragments = fragments.filter((f) => f.key === 'plan_protocol' || !this.autoOnlyKeys.includes(f.key));
    return this.assemble(planFragments, context, tools.length);
  }

  /**
   * Map tools to native tool schemas (used only when the provider supports it).
   */
  buildToolSchemas(tools: IAiTool[]): LlmToolSchema[] {
    return tools.map((t) => ({ description: t.description, name: t.name, parameters: t.parameters }));
  }

  /**
   * Built-in default prompt fragments. `content` may contain `{{placeholders}}`.
   * Override to ship different defaults (admins can also override per-key in the DB
   * via {@link CoreAiSlotService}).
   */
  protected defaultFragments(): ResolvedPromptFragment[] {
    return getSystemDefaultSlots(ConfigService.get<string>('ai.systemPrompt') || this.defaultSystemPrompt);
  }

  /**
   * Optional system documentation injected into the prompt. Reads `ai.documentation`
   * by default; override to supply RAG results / API docs.
   */
  protected getDocumentation(): string | undefined {
    return ConfigService.get<string>('ai.documentation') || undefined;
  }

  /**
   * Resolve the effective fragments: built-in defaults overlaid by admin DB rows
   * (when the template service is wired). Falls back to defaults only otherwise.
   */
  protected async resolveFragments(
    capability: string,
    locale?: string,
    scopes?: string[],
  ): Promise<ResolvedPromptFragment[]> {
    const defaults = this.defaultFragments();
    const activeScopes = scopes ?? [];
    if (!this.templateService) {
      return defaults
        .filter((f) => !f.capability || f.capability === 'all' || f.capability === capability)
        .filter((f) => !f.scope || activeScopes.includes(f.scope))
        .sort((a, b) => a.order - b.order);
    }
    return this.templateService.resolveFragments(defaults, { capability, locale, scopes: activeScopes });
  }

  /**
   * Compute the active scope tags for a run: `tool:<name>` for each tool in scope,
   * `role:<name>` for each user role, and `mode:<name>` if a named mode is active.
   * Used to filter scoped prompt fragments via {@link CoreAiSlotService.resolveFragments}.
   */
  protected computeScopes(
    tools: IAiTool[],
    user?: { id?: string; roles?: string[] },
    options?: BuildPromptOptions & { mode?: string },
  ): string[] {
    const scopes: string[] = [];
    for (const tool of tools || []) {
      if (tool?.name) {
        scopes.push(`tool:${tool.name}`);
      }
    }
    for (const role of user?.roles || []) {
      scopes.push(`role:${role}`);
    }
    if (options?.mode) {
      scopes.push(`mode:${options.mode}`);
    }
    return scopes;
  }

  /**
   * Compute placeholder values for the run. Resolves via {@link CoreAiPlaceholderRegistry}
   * when wired, so project-registered placeholders are honored automatically; falls
   * back to a hard-coded record when no registry is available.
   */
  protected async renderContext(
    tools: IAiTool[],
    user?: { id?: string; roles?: string[] },
  ): Promise<Record<string, string>> {
    // Deferred tool-schemas (#13): with many tools the full JSON-Schema catalog can
    // dominate the system prompt. When `ai.deferToolSchemas` is on, the catalog
    // emits ONLY the tool names + short descriptions; the LLM uses the built-in
    // `search_tools` meta-tool to fetch the parameter schema for a tool on demand.
    const defer = ConfigService.get<boolean>('ai.deferToolSchemas') === true;
    const toolCatalog = defer
      ? (tools.map((t) => `- ${t.name}: ${t.description}`).join('\n') || '(none)') +
        '\n\n[Schemas deferred. Call `search_tools` with the tool name to fetch its parameter schema BEFORE you call it.]'
      : tools
          .map((t) => `- ${t.name}: ${t.description}\n  parameters (JSON schema): ${JSON.stringify(t.parameters)}`)
          .join('\n') || '(none)';

    if (this.placeholderRegistry) {
      return this.placeholderRegistry.resolveAll({ toolCatalog, tools, user });
    }

    // Fallback when the registry isn't wired (legacy / unit-test paths).
    const learned = this.hintService ? await this.hintService.approvedHints(tools.map((t) => t.name)) : [];
    return {
      documentation: this.getDocumentation() || '',
      learnedHints: learned.length ? learned.map((h) => `- ${h}`).join('\n') : '',
      roles: user?.roles?.length ? user.roles.join(', ') : 'none',
      toolCatalog,
      tools: tools.map((t) => t.name).join(', ') || 'none',
      userId: user?.id || '',
    };
  }

  /** Render placeholders, drop empty/irrelevant fragments, and join. */
  protected assemble(fragments: ResolvedPromptFragment[], context: Record<string, string>, toolCount: number): string {
    const parts: string[] = [];
    for (const fragment of fragments) {
      // Skip fragments whose driving placeholder is empty or that need tools.
      if (fragment.key === 'documentation' && !context.documentation) {
        continue;
      }
      if (fragment.key === 'learned_hints' && !context.learnedHints) {
        continue;
      }
      if (this.toolKeys.includes(fragment.key) && toolCount === 0) {
        continue;
      }
      const rendered = this.render(fragment.content, context).trim();
      if (rendered) {
        parts.push(rendered);
      }
    }
    return parts.join('\n\n');
  }

  /** Replace `{{placeholder}}` tokens with their values (unknown tokens become ''). */
  protected render(template: string, context: Record<string, string>): string {
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => context[key] ?? '');
  }
}
