import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CoreAiConversationInput } from './core-ai-conversation.input';

/**
 * Input to create a new AI conversation (same shape as the update input; both
 * fields are optional). Separate class to allow project-specific extension.
 */
@InputType({ description: 'Input to create a new AI conversation', isAbstract: true })
@Restricted(RoleEnum.S_USER)
export class CoreAiConversationCreateInput extends CoreAiConversationInput {}
