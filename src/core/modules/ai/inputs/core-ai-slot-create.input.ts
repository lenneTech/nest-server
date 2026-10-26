import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator.js';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator.js';
import { RoleEnum } from '../../../common/enums/role.enum.js';
import { CoreAiSlotUpdateInput } from './core-ai-slot-update.input.js';

/**
 * Input to create an AI slot (system-prompt building block). `key` and `content`
 * are required.
 */
@InputType({ description: 'Input to create an AI slot (system-prompt building block)', isAbstract: true })
@Restricted(RoleEnum.ADMIN)
export class CoreAiSlotCreateInput extends CoreAiSlotUpdateInput {
  @UnifiedField({
    description: 'Slot text — supports placeholder tokens; the active registry is served by GET /ai/placeholders',
    roles: RoleEnum.ADMIN,
  })
  override content: string = undefined;

  @UnifiedField({
    description: "Logical prompt slot key (e.g. 'base', 'permissions', 'anti_hallucination')",
    roles: RoleEnum.ADMIN,
  })
  override key: string = undefined;
}
