import { ObjectType } from '@nestjs/graphql';
import type { Types } from 'mongoose';

import { Restricted } from '../../../core/common/decorators/restricted.decorator.js';
import { UnifiedField } from '../../../core/common/decorators/unified-field.decorator.js';
import { RoleEnum } from '../../../core/common/enums/role.enum.js';
import { equalIds } from '../../../core/common/helpers/id.helper.js';
import { CorePersistenceModel } from '../../../core/common/models/core-persistence.model.js';
import {
  objectIdType,
  Schema as MongooseSchema,
  SchemaFactory,
} from '../../../core/common/persistence/mongo/mongoose-compat.js';
import { PersistedModel } from '../../../core/common/persistence/persisted-model.decorator.js';
import { SyncField } from '../../../core/modules/sync/core-sync.decorators.js';

/**
 * A note offered to offline clients — the reference implementation of a synchronized model
 * (`src/core/modules/sync/INTEGRATION-CHECKLIST.md`).
 *
 * Not part of the reference server: `ServerModule` does not import it, so the framework's own suite runs without sync.
 * The sync contract suite (`tests/sync-contract.e2e-spec.ts`) runs on exactly these files.
 *
 * - `sync.roles`: who may pull, create, change and delete through `/sync`. The roles of a project's own routes do not
 *   reach the sync routes, so they are declared here; `S_CREATOR` is decided against the stored record.
 * - `sync.strategy: 'merge'`: a change based on an older version keeps the fields the client changed — unless one of
 *   them is `@SyncField('reject')`, which still conflicts.
 * - `securityCheck()`: every user sees their own notes. A pull runs every record through it, a push decides with it
 *   whether an id belongs to a record the caller may see.
 */
@PersistedModel({
  sync: {
    roles: {
      create: [RoleEnum.S_USER],
      delete: [RoleEnum.ADMIN, RoleEnum.S_CREATOR],
      pull: [RoleEnum.S_USER],
      update: [RoleEnum.ADMIN, RoleEnum.S_CREATOR],
    },
    strategy: 'merge',
  },
})
@MongooseSchema({ timestamps: true })
@ObjectType({ description: 'Note synchronized to offline clients' })
@Restricted(RoleEnum.ADMIN)
export class SyncNote extends CorePersistenceModel {
  @UnifiedField({ description: 'Text of the note', isOptional: true, mongoose: true, roles: RoleEnum.S_EVERYONE })
  body?: string = undefined;

  /** Set by `CrudService.create()`; what `S_CREATOR` and `securityCheck()` decide on */
  @UnifiedField({
    description: 'ID of the user who created the note',
    isOptional: true,
    mongoose: { type: objectIdType() },
    roles: RoleEnum.S_EVERYONE,
    swaggerApiOptions: { type: String },
    type: () => String,
  })
  createdBy?: string | Types.ObjectId = undefined;

  /** A concurrent change of the priority is never merged silently: it answers `conflict` */
  @SyncField('reject')
  @UnifiedField({ description: 'Priority of the note', isOptional: true, mongoose: true, roles: RoleEnum.S_EVERYONE })
  priority?: number = undefined;

  @UnifiedField({ description: 'Title of the note', isOptional: true, mongoose: true, roles: RoleEnum.S_EVERYONE })
  title?: string = undefined;

  /** Every user sees the notes they created; administrators see all */
  override securityCheck(user: any, force?: boolean) {
    if (force || user?.hasRole?.([RoleEnum.ADMIN]) || (user?.id && equalIds(this.createdBy, user))) {
      return this;
    }
    return undefined;
  }
}

export const SyncNoteSchema = SchemaFactory.createForClass(SyncNote);
