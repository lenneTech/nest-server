import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { JSON } from '../../../common/scalars/json.scalar';

/**
 * Input for an AI prompt sent from the frontend.
 */
@InputType({ description: 'Input for an AI prompt', isAbstract: true })
@Restricted(RoleEnum.S_USER)
export class CoreAiPromptInput {
  /**
   * Optional id of the AI connection to use (defaults to the configured default).
   */
  @UnifiedField({
    description: 'Id of the AI connection to use (defaults to the configured default)',
    isOptional: true,
    roles: RoleEnum.S_USER,
  })
  connectionId?: string = undefined;

  /**
   * Optional conversation id for multi-turn continuation.
   */
  @UnifiedField({
    description: 'Conversation id for multi-turn continuation',
    isOptional: true,
    roles: RoleEnum.S_USER,
  })
  conversationId?: string = undefined;

  /**
   * Optional structured context the frontend wants the assistant to consider.
   */
  @UnifiedField({
    description: 'Optional structured context for the assistant',
    isOptional: true,
    roles: RoleEnum.S_USER,
    type: () => JSON,
  })
  context?: Record<string, any> = undefined;

  /**
   * The user's prompt text.
   */
  @UnifiedField({
    description: 'The user prompt text',
    roles: RoleEnum.S_USER,
  })
  prompt: string = undefined;
}
