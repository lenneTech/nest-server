import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../../core/common/decorators/restricted.decorator.js';
import { UnifiedField } from '../../../../core/common/decorators/unified-field.decorator.js';
import { RoleEnum } from '../../../../core/common/enums/role.enum.js';
import { CoreInput } from '../../../../core/common/inputs/core-input.input.js';

/**
 * Input of a pushed change of a note — validated and whitelisted like a request body, so a client can set only what
 * is declared here (never `createdBy`, `version` or `deletedAt`)
 */
@InputType({ description: 'Input to change a synchronized note' })
@Restricted(RoleEnum.ADMIN)
export class SyncNoteInput extends CoreInput {
  @UnifiedField({ description: 'Text of the note', isOptional: true, roles: RoleEnum.S_EVERYONE })
  body?: string = undefined;

  @UnifiedField({ description: 'Priority of the note', isOptional: true, roles: RoleEnum.S_EVERYONE })
  priority?: number = undefined;

  @UnifiedField({ description: 'Title of the note', isOptional: true, roles: RoleEnum.S_EVERYONE })
  title?: string = undefined;
}
