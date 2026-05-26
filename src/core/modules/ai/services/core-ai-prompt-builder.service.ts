import { Injectable, Optional } from '@nestjs/common';

import { ConfigService } from '../../../common/services/config.service';
import { IAiTool } from '../interfaces/ai-tool.interface';
import { LlmToolSchema } from '../interfaces/llm-provider.interface';
import { CoreAiPromptHintService } from './core-ai-prompt-hint.service';
import { CoreAiPromptTemplateService, ResolvedPromptFragment } from './core-ai-prompt-template.service';

/** Options for a prompt build (locale for template/hint selection). */
export interface BuildPromptOptions {
  language?: string;
}

/**
 * Builds the system prompt and tool catalog for a prompt run.
 *
 * The prompt is assembled from keyed fragments: built-in {@link defaultFragments}
 * overlaid by admin-editable rows from {@link CoreAiPromptTemplateService}, plus
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
    @Optional() protected readonly templateService?: CoreAiPromptTemplateService,
    @Optional() protected readonly hintService?: CoreAiPromptHintService,
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
    const fragments = await this.resolveFragments(capability, options?.language);
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
    const fragments = await this.resolveFragments('emulated', options?.language);
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
   * via {@link CoreAiPromptTemplateService}).
   */
  protected defaultFragments(): ResolvedPromptFragment[] {
    const base = ConfigService.get<string>('ai.systemPrompt') || this.defaultSystemPrompt;
    return [
      { content: base, key: 'base', order: 10 },
      { content: 'System documentation:\n{{documentation}}', key: 'documentation', order: 20 },
      {
        content:
          'Your permissions and capabilities:\n' +
          '- roles: {{roles}}\n' +
          '- available tools (you may ONLY use these): {{tools}}\n' +
          'Never claim to perform an action you have no tool for, and never assume rights you do not have. ' +
          'Tools are executed with the current user permissions; the backend rejects anything beyond them.',
        key: 'permissions',
        order: 30,
      },
      {
        content:
          'Accuracy rules — follow strictly:\n' +
          '- NEVER invent, guess or assume data (ids, names, emails, numbers, dates, statuses).\n' +
          '- Use a tool to obtain any fact you are unsure about.\n' +
          "- If no available tool can provide the needed information, tell the user you don't have it " +
          'instead of fabricating an answer.\n' +
          '- Only report a value you actually received from a tool result.',
        key: 'anti_hallucination',
        order: 40,
      },
      {
        capability: 'native',
        content:
          'You can call the provided tools (native function calling). Available tools:\n{{toolCatalog}}\n' +
          'Call a tool whenever it is needed to obtain data or perform an action.',
        key: 'tool_catalog',
        order: 50,
      },
      {
        capability: 'emulated',
        content:
          'You can call backend tools to fetch or modify data. Available tools:\n{{toolCatalog}}\n\n' +
          'To call tools, respond with ONLY a JSON object (no prose, no markdown code fences):\n' +
          '{"tool_calls":[{"name":"<tool_name>","arguments":{ ... }}]}\n' +
          'You may request multiple tools at once. After emitting tool_calls, STOP and output nothing ' +
          'else — do NOT write the results yourself. The system will send the real results back in a ' +
          'message starting with "TOOL_RESULTS:"; only then continue.\n\n' +
          'CRITICAL: To perform any action you MUST emit a tool_calls request and wait for its ' +
          'TOOL_RESULTS. Never state in a final answer that you executed, performed, deleted, updated, ' +
          'or created anything unless you actually called the matching tool and received its results. ' +
          'If you have not called the tool yet, call it — do not claim success.',
        key: 'tool_protocol_emulated',
        order: 50,
      },
      {
        content:
          'PLAN MODE: Do NOT execute anything. Available tools:\n{{toolCatalog}}\n\n' +
          'Respond with ONLY a JSON object describing the COMPLETE ordered plan of tool calls needed to ' +
          'fulfil the request:\n' +
          '{"plan":[{"name":"<tool_name>","arguments":{ ... }}],"summary":"<short summary>"}\n' +
          'List every required step in order. If no tools are needed, return an empty plan array. ' +
          'Reply with valid JSON only — no prose, no markdown code fences.',
        key: 'plan_protocol',
        order: 55,
      },
      {
        capability: 'emulated',
        content:
          'When you have the final answer for the user, respond with ONLY a JSON object:\n' +
          '{"final":"<your natural language answer>","data": <optional structured data or null>}\n' +
          'Never mix tool_calls and final in the same response. Always reply with valid JSON only.',
        key: 'output_contract',
        order: 60,
      },
      {
        content:
          'Tool error handling: a tool result with "success": false includes an "error" object ' +
          '({ code, message, hint }). When that happens, do NOT pretend it worked. Read the hint, ' +
          'correct your arguments and retry if it is sensible, otherwise clearly explain the problem to ' +
          'the user in plain language.',
        key: 'error_guidance',
        order: 70,
      },
      { content: 'Learned guidance (avoid past mistakes):\n{{learnedHints}}', key: 'learned_hints', order: 80 },
    ];
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
  protected async resolveFragments(capability: string, locale?: string): Promise<ResolvedPromptFragment[]> {
    const defaults = this.defaultFragments();
    if (!this.templateService) {
      return defaults
        .filter((f) => !f.capability || f.capability === 'all' || f.capability === capability)
        .sort((a, b) => a.order - b.order);
    }
    return this.templateService.resolveFragments(defaults, { capability, locale });
  }

  /** Compute placeholder values for the run. */
  protected async renderContext(
    tools: IAiTool[],
    user?: { id?: string; roles?: string[] },
  ): Promise<Record<string, string>> {
    const learned = this.hintService ? await this.hintService.approvedHints(tools.map((t) => t.name)) : [];
    return {
      documentation: this.getDocumentation() || '',
      learnedHints: learned.length ? learned.map((h) => `- ${h}`).join('\n') : '',
      roles: user?.roles?.length ? user.roles.join(', ') : 'none',
      toolCatalog:
        tools
          .map((t) => `- ${t.name}: ${t.description}\n  parameters (JSON schema): ${JSON.stringify(t.parameters)}`)
          .join('\n') || '(none)',
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
