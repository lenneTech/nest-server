import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CrudService } from '../../../common/services/crud.service';
import { CoreModelConstructor } from '../../../common/types/core-model-constructor.type';
import { AiInteractionDocument, CoreAiInteraction } from '../models/core-ai-interaction.model';
import type { AiInteractionRecord } from './core-ai.service';

/**
 * Mongoose injection token for the AI interaction model.
 */
export const AI_INTERACTION_MODEL = 'AiInteraction';

/**
 * DI token for the AI interaction model constructor.
 */
export const AI_INTERACTION_CLASS = 'AI_INTERACTION_CLASS';

/**
 * CRUD + write service for {@link CoreAiInteraction} audit records.
 *
 * `record()` persists a run system-internally (no user context). The standard
 * CrudService methods power admin read endpoints. Extend and pass via
 * `CoreAiModule.forRoot({ interactionService })` to customize.
 */
@Injectable()
export class CoreAiInteractionService extends CrudService<CoreAiInteraction> {
  constructor(
    @InjectModel(AI_INTERACTION_MODEL) protected override readonly mainDbModel: Model<AiInteractionDocument>,
    @Inject(AI_INTERACTION_CLASS)
    protected override readonly mainModelConstructor: CoreModelConstructor<CoreAiInteraction>,
  ) {
    super();
  }

  /**
   * Persist an audit record. System-internal (direct model access, no user).
   * `tenantId` is auto-set by the tenant plugin from the request context, but is
   * passed through explicitly when known for robustness.
   */
  async record(rec: AiInteractionRecord): Promise<void> {
    await this.mainDbModel.create({
      actions: rec.actions,
      completionTokens: rec.usage?.completionTokens,
      connectionId: rec.connectionId,
      iterations: rec.iterations,
      prompt: rec.prompt,
      promptTokens: rec.usage?.promptTokens,
      responseText: rec.responseText,
      tenantId: rec.tenantId,
      totalTokens: rec.usage?.totalTokens,
      userId: rec.userId,
    });
  }
}
