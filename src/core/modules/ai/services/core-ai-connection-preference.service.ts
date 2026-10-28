import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { upsertRecord } from '../../../common/persistence/store-upsert.js';
import { CrudService } from '../../../common/services/crud.service.js';
import type { CoreModelConstructor } from '../../../common/types/core-model-constructor.type.js';
import { CoreAiConnectionPreferenceInput } from '../inputs/core-ai-connection-preference.input.js';
import {
  AiConnectionPreferenceDocument,
  CoreAiConnectionPreference,
} from '../models/core-ai-connection-preference.model.js';

import { AI_CONNECTION_PREFERENCE_CLASS, AI_CONNECTION_PREFERENCE_MODEL } from '../core-ai.constants.js';

/**
 * @deprecated Import from `../core-ai.constants` instead. Re-exported only so existing deep imports
 * keep working; the tokens are declared in an import-free leaf so no cycle can form around them
 * (SWC-safe — see core-ai.constants.ts).
 */
export { AI_CONNECTION_PREFERENCE_CLASS, AI_CONNECTION_PREFERENCE_MODEL } from '../core-ai.constants.js';

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
    const doc = (await this.dataStore.findOne({ refId, scope })) as Partial<CoreAiConnectionPreference> | null;
    return doc ? { connectionId: doc.connectionId, enforced: doc.enforced } : null;
  }

  /**
   * Delete all preferences pointing to a connection (used when a connection is
   * removed, to avoid dangling tenant/user preferences). Returns the deleted count.
   */
  async deleteByConnectionId(connectionId: string): Promise<number> {
    return this.dataStore.deleteMany({ connectionId });
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
    const doc = await upsertRecord(this.dataStore, { refId, scope }, { connectionId, enforced });
    return this.mainModelConstructor.map(doc);
  }
}
