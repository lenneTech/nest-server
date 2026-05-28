import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { CoreInput } from '../../../common/inputs/core-input.input';
import { RoleEnum } from '../../../common/enums/role.enum';

/** Input for updating a {@link CoreAiPrompt}. All fields optional. */
@InputType({ description: 'Input to update a user prompt' })
@Restricted(RoleEnum.S_USER)
export class CoreAiPromptUpdateInput extends CoreInput {
  @UnifiedField({ description: 'The prompt text', isOptional: true, roles: RoleEnum.S_USER })
  content?: string = undefined;

  @UnifiedField({ description: 'Description', isOptional: true, roles: RoleEnum.S_USER })
  description?: string = undefined;

  @UnifiedField({
    description: 'Whether the prompt is active',
    isOptional: true,
    roles: RoleEnum.S_USER,
    type: () => Boolean,
  })
  enabled?: boolean = undefined;

  @UnifiedField({ description: 'Icon hint', isOptional: true, roles: RoleEnum.S_USER })
  icon?: string = undefined;

  @UnifiedField({ description: 'Display label', isOptional: true, roles: RoleEnum.S_USER })
  name?: string = undefined;

  @UnifiedField({
    description: 'Sort order',
    isOptional: true,
    roles: RoleEnum.S_USER,
    type: () => Number,
  })
  order?: number = undefined;

  @UnifiedField({ description: 'Visibility scope', isOptional: true, roles: RoleEnum.S_USER })
  scope?: string = undefined;
}
