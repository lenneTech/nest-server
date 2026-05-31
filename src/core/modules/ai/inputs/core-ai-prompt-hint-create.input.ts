import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CoreAiPromptHintInput } from './core-ai-prompt-hint.input';

/**
 * Input to create a learned AI prompt hint manually. `content` and `trigger` are
 * required (the learning loop normally creates these automatically).
 */
@InputType({ description: 'Input to create a learned AI prompt hint', isAbstract: true })
@Restricted(RoleEnum.ADMIN)
export class CoreAiPromptHintCreateInput extends CoreAiPromptHintInput {
  @UnifiedField({
    description: 'Guidance text added to the prompt when approved',
    roles: RoleEnum.ADMIN,
  })
  override content: string = undefined;

  @UnifiedField({
    description: 'Failure-pattern identifier that produced the hint',
    roles: RoleEnum.ADMIN,
  })
  trigger: string = undefined;
}
