import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '../../../common/persistence/mongo/mongoose-compat.js';
import type { Model } from 'mongoose';

import { CrudService } from '../../../common/services/crud.service.js';
import type { CoreModelConstructor } from '../../../common/types/core-model-constructor.type.js';
import { AiModeDocument, CoreAiMode } from '../models/core-ai-mode.model.js';

import { AI_MODE_CLASS, AI_MODE_MODEL } from '../core-ai.constants.js';

/**
 * @deprecated Import from `../core-ai.constants` instead. Re-exported only so existing deep imports
 * keep working; the tokens are declared in an import-free leaf so no cycle can form around them
 * (SWC-safe — see core-ai.constants.ts).
 */
export { AI_MODE_CLASS, AI_MODE_MODEL } from '../core-ai.constants.js';

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
      const row = (await this.dataStore.findOne({ enabled: { $ne: false }, name })) as CoreAiMode | null;
      return row || null;
    } catch (err) {
      this.logger.warn(`Failed to load mode "${name}": ${(err as Error).message}`);
      return null;
    }
  }
}
