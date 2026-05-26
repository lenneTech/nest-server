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
   * key, honoring locale + capability). Placeholders are NOT yet rendered — the
   * prompt builder does that.
   */
  async resolveFragments(
    defaults: ResolvedPromptFragment[],
    options?: { capability?: string; locale?: string },
  ): Promise<ResolvedPromptFragment[]> {
    const capability = options?.capability ?? 'all';
    const locale = options?.locale;

    // Start from the built-in defaults keyed by their slot.
    const byKey = new Map<string, ResolvedPromptFragment>();
    for (const def of defaults) {
      if (this.fragmentApplies(def.capability, capability)) {
        byKey.set(def.key, { ...def });
      }
    }

    // Overlay DB rows (enabled only). A locale-specific row beats a generic one.
    let rows: CoreAiPromptTemplate[] = [];
    try {
      rows = await this.mainDbModel
        .find({ enabled: { $ne: false } })
        .lean<CoreAiPromptTemplate[]>()
        .exec();
    } catch {
      rows = [];
    }
    const localeRank = (rowLocale?: string): number => (rowLocale && rowLocale === locale ? 2 : rowLocale ? 0 : 1);
    const chosen = new Map<string, { rank: number; row: CoreAiPromptTemplate }>();
    for (const row of rows) {
      if (!row?.key || !row?.content) {
        continue;
      }
      if (row.locale && locale && row.locale !== locale) {
        continue; // locale-specific row for another language
      }
      if (!this.fragmentApplies(row.capability, capability)) {
        continue;
      }
      const rank = localeRank(row.locale);
      const current = chosen.get(row.key);
      if (!current || rank > current.rank) {
        chosen.set(row.key, { rank, row });
      }
    }
    for (const [key, { row }] of chosen) {
      byKey.set(key, {
        capability: row.capability,
        content: row.content,
        key,
        order: typeof row.order === 'number' ? row.order : (byKey.get(key)?.order ?? 100),
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
}
