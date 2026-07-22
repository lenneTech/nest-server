import { Injectable, Logger, Optional } from '@nestjs/common';

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
  protected readonly logger = new Logger(CoreAiPromptBuilderService.name);

  /** Keys that belong only to the auto (step-by-step) execution mode. */
  protected readonly autoOnlyKeys = ['output_contract', 'plan_protocol', 'tool_catalog', 'tool_protocol_emulated'];

  /** Default base system prompt (used when `ai.systemPrompt` is not configured). */
  protected readonly defaultSystemPrompt =
    'You are a helpful assistant integrated into a business application. ' +
    'Answer concisely and only use information you can obtain through the provided tools. ' +
    'Never invent data. If a request cannot be fulfilled with the available tools, say so.';

  /** Keys that describe tool calling (skipped when the user has no tools). */
  protected readonly toolKeys = ['output_contract', 'plan_protocol', 'tool_catalog', 'tool_protocol_emulated'];

  /** Latched after the first {@link warnOnOrphanedSummaryCap} evaluation, so the check runs once per instance. */
  private orphanedSummaryCapChecked = false;

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
    const context = await this.renderContext(tools, user, supportsNativeTools);
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
    // Plan mode always uses the emulated protocol (it sends no native schemas), so
    // `supportsNativeTools` stays false here — but the deferral banner must differ:
    // the model gets no chance to call `search_tools` before committing to a plan.
    const context = await this.renderContext(tools, user, false, true);
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
    supportsNativeTools = false,
    planMode = false,
  ): Promise<Record<string, string>> {
    // Deferred tool-schemas (#13): with many tools the full JSON-Schema catalog can
    // dominate the system prompt. When `ai.deferToolSchemas` is on, the catalog
    // emits ONLY the tool names + SHORT descriptions; the LLM uses the built-in
    // `search_tools` meta-tool to fetch the full description and the parameter
    // schema for a tool on demand.
    const defer = ConfigService.get<boolean>('ai.deferToolSchemas') === true;
    this.warnOnOrphanedSummaryCap(defer);
    // Truncation and the `search_tools` banner apply to EMULATED providers only.
    // With native tool calling the provider already receives every full description
    // AND schema through `buildToolSchemas()`, so a truncated catalog entry would be
    // contradicted by the tool payload sitting next to it, and instructing the model
    // to spend a `search_tools` round-trip (against `maxIterations`) to recover text
    // it was already given is pure loss. Keep the catalog compact either way, but
    // never claim a truncation that did not happen.
    const summaryChars = supportsNativeTools ? 0 : (ConfigService.get<number>('ai.deferToolSummaryChars') ?? 0);
    // Only mention truncation when descriptions can actually be truncated — with the
    // default cap of 0 the deferred catalog is byte-identical to the uncapped one.
    let deferNote = '';
    if (defer && !supportsNativeTools) {
      if (planMode) {
        // Plan mode answers with a COMPLETE plan and executes nothing, so the model
        // never receives a `search_tools` result before it has to commit. Telling it
        // to call `search_tools` first would only burn a plan step on a lookup whose
        // answer arrives too late — say what it can actually act on instead.
        deferNote =
          summaryChars > 0
            ? '\n\n[Schemas and full descriptions are not shown. A description ending in `…` is ABBREVIATED and may omit ' +
              'preconditions or role restrictions. You cannot look them up while planning — prefer tools whose visible ' +
              'description clearly matches the request, and keep the plan conservative.]'
            : '\n\n[Parameter schemas are not shown. Plan with the descriptions above; the parameters are validated when ' +
              'the plan runs.]';
      } else {
        deferNote =
          summaryChars > 0
            ? '\n\n[Schemas deferred. A description ending in `…` is TRUNCATED — the omitted part often carries required ' +
              'preconditions and role restrictions. Call `search_tools` with the tool name to fetch its full description ' +
              'and parameter schema BEFORE you call it.]'
            : '\n\n[Schemas deferred. Call `search_tools` with the tool name to fetch its parameter schema BEFORE you call it.]';
      }
    }
    const toolCatalog = defer
      ? (tools.map((t) => `- ${t.name}: ${this.summarizeToolDescription(t.description, summaryChars)}`).join('\n') ||
          '(none)') + deferNote
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

  /**
   * Warn once when `deferToolSummaryChars` is set without `deferToolSchemas`.
   * The cap only applies to the deferred catalog, so on its own it does nothing —
   * a silent no-op is the worst outcome for someone who set it to reclaim context
   * and is now wondering why the token count did not move.
   */
  protected warnOnOrphanedSummaryCap(defer: boolean): void {
    if (defer || this.orphanedSummaryCapChecked) {
      return;
    }
    // Latch on the FIRST evaluation, not only when a warning is emitted — otherwise
    // the config read below repeats on every prompt build in the (common) case where
    // there is nothing to warn about.
    this.orphanedSummaryCapChecked = true;
    if ((ConfigService.get<number>('ai.deferToolSummaryChars') ?? 0) > 0) {
      this.logger.warn(
        'ai.deferToolSummaryChars is set but ai.deferToolSchemas is false — the cap only applies to the ' +
          'deferred tool catalog and is ignored. Enable ai.deferToolSchemas to use it.',
      );
    }
  }

  /**
   * Abbreviate a tool description for the DEFERRED catalog so the catalog stays
   * as compact as `deferToolSchemas` promises. Keeps whole sentences up to
   * `maxChars` (always at least the first one), and hard-cuts on a word boundary
   * when the first sentence already exceeds the cap. A shortened result ALWAYS
   * ends in `…` so the model can see that something was omitted — the catalog
   * banner tells it that the omitted part may carry preconditions and role
   * restrictions, and `search_tools` returns the full text on demand.
   *
   * The `…` is appended ON TOP of the cap, so a shortened result is `maxChars + 1`
   * characters — the cap bounds the kept TEXT, not the returned string.
   *
   * The result is always a PREFIX of the input. That is not free: the sentence
   * splitter cannot match across `e.g.` / `i.e.` (a period without trailing
   * whitespace), and iterating over the match STRINGS would silently drop the
   * skipped region out of the middle — turning "…a flat object keyed by field
   * key (call list_fields …, e.g. name)" into "…field key. g. name)", which
   * still reads as valid prose. Slicing the original up to the END of the last
   * accepted match keeps skipped regions in place.
   *
   * `maxChars <= 0` disables the abbreviation (full descriptions).
   */
  protected summarizeToolDescription(description: string, maxChars: number): string {
    const text = (description || '').trim();
    if (!maxChars || maxChars <= 0 || text.length <= maxChars) {
      return text;
    }
    // Track the END OFFSET of the last accepted sentence and slice the original —
    // never concatenate the matches themselves (see the prefix note above).
    //
    // The pattern matches the TERMINATOR ONLY, via a lookahead. A leading `[^.!?]+`
    // (matching the sentence body) would be quadratic: it consumes greedily to the
    // end of the string, backtracks one character at a time when the terminator
    // fails, and `matchAll` then advances the start position and repeats the whole
    // walk. On a 100 KB description without a terminator that measured 6.7 SECONDS
    // of blocked event loop — per prompt build, and tool descriptions can come from
    // a remote MCP server (`CoreAiMcpClientService.buildWrapperTool`), which is
    // outside this process's control. The early `break` does not save it either:
    // the generator computes the next failing match before the loop can exit.
    //
    // One behavioural difference from the `[^.!?]+`-prefixed form: that pattern
    // needed at least one non-terminator character first, so it could not see a
    // boundary at position 0 or right after whitespace. The lookahead can. Only
    // descriptions that OPEN with punctuation are affected, the result is still a
    // prefix and still within the cap — verified across 1.5M adversarial inputs.
    let end = 0;
    for (const match of text.matchAll(/[.!?]+(?=\s|$)/g)) {
      const next = (match.index ?? 0) + match[0].length;
      if (end && text.slice(0, next).trimEnd().length > maxChars) {
        break;
      }
      end = next;
      if (text.slice(0, end).trimEnd().length >= maxChars) {
        break;
      }
    }
    let summary = text.slice(0, end).trimEnd();
    if (summary.length > maxChars || !summary) {
      // No usable sentence boundary within the cap: hard-cut on a word boundary.
      const cut = text.slice(0, maxChars);
      const lastSpace = cut.lastIndexOf(' ');
      summary = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
    }
    return summary.length < text.length ? `${summary}…` : summary;
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
