import { Field, ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';

/**
 * A single message in an AI conversation (stored as a Mongoose Mixed subdocument).
 */
@ObjectType({ description: 'A message in an AI conversation' })
@Restricted(RoleEnum.S_EVERYONE)
export class CoreAiMessage {
  /**
   * Message content.
   */
  @Field(() => String, { description: 'Message content' })
  content: string;

  /**
   * Creation timestamp.
   */
  @Field(() => Date, { description: 'Creation timestamp', nullable: true })
  createdAt?: Date;

  /**
   * Author role ('user' or 'assistant').
   */
  @Field(() => String, { description: "Author role ('user' or 'assistant')" })
  role: string;
}
