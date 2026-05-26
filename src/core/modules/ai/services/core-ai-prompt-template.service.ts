import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CrudService } from '../../../common/services/crud.service';
import { CoreModelConstructor } from '../../../common/types/core-model-constructor.type';
import { CoreAiPromptTemplateCreateInput } from '../inputs/core-ai-prompt-template-create.input';
import { CoreAiPromptTemplateInput } from '../inputs/core-ai-prompt-template.input';
import { AiPromptTemplateDocument, CoreAiPromptTemplate } from '../models/core-ai-prompt-template.model';

/** Mongoose injection token for the prompt-template model. */
export const AI_PROMPT_TEMPLATE_MODEL = 'AiPromptTemplate';

/** DI token for the prompt-template model constructor. */
export const AI_PROMPT_TEMPLATE_CLASS = 'AI_PROMPT_TEMPLATE_CLASS';

/** A resolved prompt fragment ready for placeholder rendering + assembly. */
export interface ResolvedPromptFragment {
  capability?: string;
  content: string;
  key: string;
  order: number;
  scope?: string;
}

/**
 * Admin-editable store of system-prompt building blocks. Ships built-in defaults for
 * every {@link CoreAiPromptTemplateService.defaultFragments} key, so the prompt works
 * with zero DB rows; a stored row **overrides** the default for its key (optionally
 * scoped by `locale`/`capability`). This keeps the whole prompt transparent and
 * adjustable — by admins and the governed learning loop — rather than hard-coded.
 *
 * Override this class via `CoreModule.forRoot(env, { ai: { promptTemplateService } })`
 * to ship different defaults or composition rules.
 */
@Injectable()
export class CoreAiPromptTemplateService extends CrudService<
  CoreAiPromptTemplate,
  CoreAiPromptTemplateCreateInput,
  CoreAiPromptTemplateInput
> {
  constructor(
    @InjectModel(AI_PROMPT_TEMPLATE_MODEL) protected override readonly mainDbModel: Model<AiPromptTemplateDocument>,
    @Inject(AI_PROMPT_TEMPLATE_CLASS)
    protected override readonly mainModelConstructor: CoreModelConstructor<CoreAiPromptTemplate>,
  ) {
    super();
  }

  /**
   * Resolve the effective, ordered prompt fragments for a run: the provided built-in
   * defaults (owned by the prompt builder) overlaid by enabled DB rows (matched by
   * key, honoring locale + capability + `scope`). Placeholders are NOT yet rendered —
   * the prompt builder does that.
   *
   * `scopes` is the set of active run scopes (e.g. `['tool:get_user', 'role:admin',
   * 'mode:support']`); a fragment whose `scope` is set must match at least one of them.
   * Fragments without a scope always apply.
   */
  async resolveFragments(
    defaults: ResolvedPromptFragment[],
    options?: { capability?: string; locale?: string; scopes?: string[] },
  ): Promise<ResolvedPromptFragment[]> {
    const capability = options?.capability ?? 'all';
    const locale = options?.locale;
    const scopes = options?.scopes ?? [];

    // Start from the built-in defaults keyed by their slot.
    const byKey = new Map<string, ResolvedPromptFragment>();
    for (const def of defaults) {
      if (this.fragmentApplies(def.capability, capability) && this.scopeApplies(def.scope, scopes)) {
        byKey.set(def.key, { ...def });
      }
    }

    // Overlay DB rows (enabled only). A locale-specific row beats a generic one; a
    // scoped row that matches beats a generic one (both are "more specific").
    let rows: CoreAiPromptTemplate[] = [];
    try {
      rows = await this.mainDbModel
        .find({ enabled: { $ne: false } })
        .lean<CoreAiPromptTemplate[]>()
        .exec();
    } catch {
      rows = [];
    }
    const rank = (row: CoreAiPromptTemplate): number =>
      (row.locale && row.locale === locale ? 2 : row.locale ? 0 : 1) + (row.scope ? 4 : 0);
    const chosen = new Map<string, { rank: number; row: CoreAiPromptTemplate }>();
    for (const row of rows) {
      if (!row?.key || !row?.content) {
        continue;
      }
      if (row.locale && locale && row.locale !== locale) {
        continue;
      }
      if (!this.fragmentApplies(row.capability, capability)) {
        continue;
      }
      if (!this.scopeApplies(row.scope, scopes)) {
        continue;
      }
      const r = rank(row);
      const current = chosen.get(row.key);
      if (!current || r > current.rank) {
        chosen.set(row.key, { rank: r, row });
      }
    }
    for (const [key, { row }] of chosen) {
      byKey.set(key, {
        capability: row.capability,
        content: row.content,
        key,
        order: typeof row.order === 'number' ? row.order : (byKey.get(key)?.order ?? 100),
        scope: row.scope,
      });
    }

    return [...byKey.values()].filter((f) => f.content?.trim()).sort((a, b) => a.order - b.order);
  }

  /**
   * Whether a fragment's capability scope applies to the run's capability.
   * `undefined`/`'all'` always applies; otherwise must match exactly.
   */
  protected fragmentApplies(fragmentCapability: string | undefined, runCapability: string): boolean {
    if (!fragmentCapability || fragmentCapability === 'all') {
      return true;
    }
    return fragmentCapability === runCapability;
  }

  /**
   * Whether a fragment's `scope` filter applies to the run's active scopes.
   * Empty/undefined scope always applies; otherwise the fragment scope must equal one
   * of the active run scopes (exact-match — patterns are not supported here).
   */
  protected scopeApplies(fragmentScope: string | undefined, runScopes: string[]): boolean {
    if (!fragmentScope) {
      return true;
    }
    return runScopes.includes(fragmentScope);
  }
}
