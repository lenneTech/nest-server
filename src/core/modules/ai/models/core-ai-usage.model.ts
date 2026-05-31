import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';

/**
 * Token usage of an AI prompt (best effort, summed across agent-loop iterations).
 */
@ObjectType({ description: 'Token usage of an AI prompt' })
@Restricted(RoleEnum.S_EVERYONE)
export class CoreAiUsage {
  /**
   * Number of completion (output) tokens.
   */
  @Field(() => Int, { description: 'Number of completion tokens', nullable: true })
  completionTokens?: number;

  /**
   * Number of prompt (input) tokens.
   */
  @Field(() => Int, { description: 'Number of prompt tokens', nullable: true })
  promptTokens?: number;

  /**
   * Total number of tokens.
   */
  @Field(() => Int, { description: 'Total number of tokens', nullable: true })
  totalTokens?: number;
}
