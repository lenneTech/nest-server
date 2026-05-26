import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CoreAiPromptTemplateInput } from './core-ai-prompt-template.input';

/**
 * Input to create an AI prompt template fragment. `key` and `content` are required.
 */
@InputType({ description: 'Input to create an AI prompt template fragment', isAbstract: true })
@Restricted(RoleEnum.ADMIN)
export class CoreAiPromptTemplateCreateInput extends CoreAiPromptTemplateInput {
  @UnifiedField({
    description: 'Fragment text (supports {{placeholders}})',
    roles: RoleEnum.ADMIN,
  })
  override content: string = undefined;

  @UnifiedField({
    description: "Logical prompt slot (e.g. 'base', 'permissions', 'anti_hallucination')",
    roles: RoleEnum.ADMIN,
  })
  override key: string = undefined;
}
