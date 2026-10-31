import { Module } from '@nestjs/common';

import { CorePersistenceModule } from '../../../core/common/persistence/core-persistence.module.js';
import { SyncNote, SyncNoteSchema } from './sync-note.model.js';
import { SyncNoteService } from './sync-note.service.js';

/**
 * The synchronized note model and its service. Registered with `CorePersistenceModule.forFeature()`, so the model
 * follows `database` like every other — and only a model registered this way can be synchronized.
 */
@Module({
  exports: [SyncNoteService],
  imports: [CorePersistenceModule.forFeature([{ model: SyncNote, name: SyncNote.name, schema: SyncNoteSchema }])],
  providers: [SyncNoteService],
})
export class SyncNoteModule {}
