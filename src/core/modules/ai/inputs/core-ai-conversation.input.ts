import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator.js';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator.js';
import { RoleEnum } from '../../../common/enums/role.enum.js';

/**
 * Input to create or update an AI conversation. Messages are not set here — they
 * are appended by the orchestrator during prompt runs.
 */
@InputType({ description: 'Input to create or update an AI conversation', isAbstract: true })
@Restricted(RoleEnum.S_USER)
export class CoreAiConversationInput {
  /**
   * Optional default connection for the conversation.
   */
  @UnifiedField({
    description: 'Optional default AI connection id for the conversation',
    isOptional: true,
    roles: RoleEnum.S_USER,
  })
  connectionId?: string = undefined;

  /**
   * Human-readable title.
   */
  @UnifiedField({
    description: 'Human-readable title',
    isOptional: true,
    roles: RoleEnum.S_USER,
  })
  title?: string = undefined;
}
