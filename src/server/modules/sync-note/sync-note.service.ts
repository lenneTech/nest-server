import { Injectable } from '@nestjs/common';

import type { DataStore } from '../../../core/common/persistence/data-store.interface.js';
import { InjectStore } from '../../../core/common/persistence/inject-store.decorator.js';
import { ConfigService } from '../../../core/common/services/config.service.js';
import { CrudService } from '../../../core/common/services/crud.service.js';
import { SyncService } from '../../../core/modules/sync/core-sync.decorators.js';
import { SyncNoteCreateInput } from './inputs/sync-note-create.input.js';
import { SyncNoteInput } from './inputs/sync-note.input.js';
import { SyncNote } from './sync-note.model.js';

/**
 * The note service, offered to offline clients: `@SyncService()` puts the model under `/sync/SyncNote`, and every pull
 * and push of it runs through this service — its `process()` pipeline, `securityCheck()`, the tenant policy.
 */
@SyncService({ createInput: SyncNoteCreateInput, model: SyncNote, updateInput: SyncNoteInput })
@Injectable()
export class SyncNoteService extends CrudService<SyncNote, SyncNoteCreateInput, SyncNoteInput> {
  constructor(
    protected override readonly configService: ConfigService,
    @InjectStore(SyncNote) store: DataStore<SyncNote>,
  ) {
    super({ configService, dataStore: store, mainModelConstructor: SyncNote });
  }
}
