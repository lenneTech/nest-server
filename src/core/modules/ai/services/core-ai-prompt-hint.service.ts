import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { ConfigService } from '../../../common/services/config.service';
import { CrudService } from '../../../common/services/crud.service';
import { CoreModelConstructor } from '../../../common/types/core-model-constructor.type';
import { CoreAiPromptHintCreateInput } from '../inputs/core-ai-prompt-hint-create.input';
import { CoreAiPromptHintInput } from '../inputs/core-ai-prompt-hint.input';
import { AiPromptHintDocument, CoreAiPromptHint } from '../models/core-ai-prompt-hint.model';

import { AI_PROMPT_HINT_CLASS, AI_PROMPT_HINT_MODEL } from '../core-ai.constants';

/**
 * @deprecated Import from `../core-ai.constants` instead. Re-exported only so existing deep imports
 * keep working; the tokens are declared in an import-free leaf so no cycle can form around them
 * (SWC-safe — see core-ai.constants.ts).
 */
export { AI_PROMPT_HINT_CLASS, AI_PROMPT_HINT_MODEL } from '../core-ai.constants';

/** A failure signal recorded by the orchestrator for the learning loop. */
export interface AiPromptFeedbackSignal {
  /** Generated guidance to add to the prompt to avoid the failure next time. */
  content: string;
  /** Optional scope (e.g. a tool name); empty = global. */
  scope?: string;
  /** Failure-pattern id (e.g. 'tool_error', 'hallucinated_execution', 'parse_failure', 'denied'). */
  trigger: string;
}

/** Resolved `ai.promptLearning` config. */
interface PromptLearningConfig {
  autoApply: boolean;
  enabled: boolean;
  minOccurrences: number;
}

/**
 * CRUD + governed self-improvement loop for learned prompt hints.
 *
 * The orchestrator reports failures via {@link recordSignal}; recurring patterns are
 * aggregated into {@link CoreAiPromptHint} rows. By default new hints are `suggested`
 * and only affect the prompt once an admin approves them; with
 * `ai.promptLearning.autoApply` they are created `approved`. {@link approvedHints}
 * feeds the active guidance into the prompt builder.
 *
 * Learning can never relax security — hints only ADD textual guidance; permissions and
 * tool gating are always enforced backend-side regardless of the prompt.
 */
@Injectable()
export class CoreAiPromptHintService extends CrudService<
  CoreAiPromptHint,
  CoreAiPromptHintCreateInput,
  CoreAiPromptHintInput
> {
  protected readonly logger = new Logger(CoreAiPromptHintService.name);

  constructor(
    @InjectModel(AI_PROMPT_HINT_MODEL) protected override readonly mainDbModel: Model<AiPromptHintDocument>,
    @Inject(AI_PROMPT_HINT_CLASS)
    protected override readonly mainModelConstructor: CoreModelConstructor<CoreAiPromptHint>,
  ) {
    super();
  }

  /**
   * Return the active learned guidance for a run: enabled, `approved` hints whose
   * scope is global or matches one of the run's tool names.
   */
  async approvedHints(scopes: string[] = []): Promise<string[]> {
    if (!this.config().enabled) {
      return [];
    }
    try {
      const rows = await this.mainDbModel
        .find({ enabled: { $ne: false }, scope: { $in: [null, '', ...scopes] }, status: 'approved' })
        .sort({ occurrences: -1 })
        .lean<CoreAiPromptHint[]>()
        .exec();
      return rows.map((r) => r.content).filter((c): c is string => !!c?.trim());
    } catch {
      return [];
    }
  }

  /**
   * Record a failure signal. Best-effort: aggregates by (trigger, scope), increments
   * the occurrence counter and creates/updates the hint. Never throws — feedback must
   * not break a prompt run.
   */
  async recordSignal(signal: AiPromptFeedbackSignal): Promise<void> {
    const config = this.config();
    if (!config.enabled || !signal?.trigger || !signal?.content) {
      return;
    }
    const scope = signal.scope || '';
    try {
      const existing = await this.mainDbModel
        .findOne({ scope, trigger: signal.trigger })
        .lean<CoreAiPromptHint>()
        .exec();
      if (existing) {
        const occurrences = (existing.occurrences ?? 1) + 1;
        const update: Record<string, unknown> = { occurrences };
        // Auto-approve once the threshold is reached (config) and not already decided.
        if (config.autoApply && existing.status === 'suggested' && occurrences >= config.minOccurrences) {
          update.status = 'approved';
        }
        await this.mainDbModel.updateOne({ _id: (existing as any)._id }, { $set: update }).exec();
        return;
      }
      const status = config.autoApply && config.minOccurrences <= 1 ? 'approved' : 'suggested';
      await this.mainDbModel.create({
        content: signal.content,
        occurrences: 1,
        scope,
        status,
        trigger: signal.trigger,
      });
    } catch (err) {
      this.logger.debug(`recordSignal skipped: ${(err as Error).message}`);
    }
  }

  /** Resolve the `ai.promptLearning` config with safe defaults. */
  protected config(): PromptLearningConfig {
    const raw = ConfigService.get<{ autoApply?: boolean; enabled?: boolean; minOccurrences?: number }>(
      'ai.promptLearning',
    );
    return {
      autoApply: raw?.autoApply === true,
      enabled: raw?.enabled !== false,
      minOccurrences: typeof raw?.minOccurrences === 'number' && raw.minOccurrences > 0 ? raw.minOccurrences : 1,
    };
  }
}
