import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../../core/common/decorators/restricted.decorator.js';
import { UnifiedField } from '../../../../core/common/decorators/unified-field.decorator.js';
import { RoleEnum } from '../../../../core/common/enums/role.enum.js';
import { SyncNoteInput } from './sync-note.input.js';

/** Input of a pushed note that creates it; the client chose its id (protocol §3) */
@InputType({ description: 'Input to create a synchronized note' })
@Restricted(RoleEnum.ADMIN)
export class SyncNoteCreateInput extends SyncNoteInput {
  @UnifiedField({ description: 'Title of the note', roles: RoleEnum.S_EVERYONE })
  override title: string = undefined;
}
