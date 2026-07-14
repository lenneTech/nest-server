import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CrudService } from '../../../common/services/crud.service';
import { CoreModelConstructor } from '../../../common/types/core-model-constructor.type';
import { CoreAiConnectionPreferenceInput } from '../inputs/core-ai-connection-preference.input';
import {
  AiConnectionPreferenceDocument,
  CoreAiConnectionPreference,
} from '../models/core-ai-connection-preference.model';

import { AI_CONNECTION_PREFERENCE_CLASS, AI_CONNECTION_PREFERENCE_MODEL } from '../core-ai.constants';

/**
 * @deprecated Import from `../core-ai.constants` instead. Re-exported only so existing deep imports
 * keep working; the tokens are declared in an import-free leaf so no cycle can form around them
 * (SWC-safe — see core-ai.constants.ts).
 */
export { AI_CONNECTION_PREFERENCE_CLASS, AI_CONNECTION_PREFERENCE_MODEL } from '../core-ai.constants';

/**
 * CRUD + lookup for {@link CoreAiConnectionPreference} (tenant/user connection
 * defaults + tenant-enforced). Used by the resolution chain.
 */
@Injectable()
export class CoreAiConnectionPreferenceService extends CrudService<
  CoreAiConnectionPreference,
  CoreAiConnectionPreferenceInput,
  CoreAiConnectionPreferenceInput
> {
  constructor(
    @InjectModel(AI_CONNECTION_PREFERENCE_MODEL)
    protected override readonly mainDbModel: Model<AiConnectionPreferenceDocument>,
    @Inject(AI_CONNECTION_PREFERENCE_CLASS)
    protected override readonly mainModelConstructor: CoreModelConstructor<CoreAiConnectionPreference>,
  ) {
    super();
  }

  /**
   * Read a preference for a scope/ref (system-internal lean read).
   */
  async getPreference(
    scope: 'tenant' | 'user',
    refId: string,
  ): Promise<{ connectionId: string; enforced?: boolean } | null> {
    const doc = await this.mainDbModel.findOne({ refId, scope }).lean().exec();
    return doc ? { connectionId: doc.connectionId, enforced: doc.enforced } : null;
  }

  /**
   * Delete all preferences pointing to a connection (used when a connection is
   * removed, to avoid dangling tenant/user preferences). Returns the deleted count.
   */
  async deleteByConnectionId(connectionId: string): Promise<number> {
    const result = await this.mainDbModel.deleteMany({ connectionId }).exec();
    return result.deletedCount ?? 0;
  }

  /**
   * Upsert a preference (one per scope/ref). System-internal; callers must
   * authorize the scope/ref (e.g. a user may only set their own user preference).
   * Returns the persisted preference as a mapped model.
   */
  async upsertPreference(
    scope: 'tenant' | 'user',
    refId: string,
    connectionId: string,
    enforced = false,
  ): Promise<CoreAiConnectionPreference> {
    const doc = await this.mainDbModel
      .findOneAndUpdate({ refId, scope }, { $set: { connectionId, enforced } }, { new: true, upsert: true })
      .lean()
      .exec();
    return this.mainModelConstructor.map(doc);
  }
}
