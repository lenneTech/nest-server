import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CrudService } from '../../../common/services/crud.service';
import { CoreModelConstructor } from '../../../common/types/core-model-constructor.type';
import { AiModeDocument, CoreAiMode } from '../models/core-ai-mode.model';

export const AI_MODE_MODEL = 'AiMode';
export const AI_MODE_CLASS = 'AI_MODE_CLASS';

/**
 * Named-mode store. See {@link CoreAiMode}. Override via
 * `CoreModule.forRoot(env, { ai: { modeService } })`.
 */
@Injectable()
export class CoreAiModeService extends CrudService<CoreAiMode, CoreAiMode, CoreAiMode> {
  protected readonly logger = new Logger(CoreAiModeService.name);

  constructor(
    @InjectModel(AI_MODE_MODEL) protected override readonly mainDbModel: Model<AiModeDocument>,
    @Inject(AI_MODE_CLASS) protected override readonly mainModelConstructor: CoreModelConstructor<CoreAiMode>,
  ) {
    super();
  }

  /** Lookup a mode by `name`. Returns `null` if missing or disabled. */
  async getByName(name: string): Promise<CoreAiMode | null> {
    if (!name) {
      return null;
    }
    try {
      const row = await this.mainDbModel
        .findOne({ enabled: { $ne: false }, name })
        .lean<CoreAiMode>()
        .exec();
      return row || null;
    } catch (err) {
      this.logger.warn(`Failed to load mode "${name}": ${(err as Error).message}`);
      return null;
    }
  }
}
