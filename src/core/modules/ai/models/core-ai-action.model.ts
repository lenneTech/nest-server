import { Field, ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { JSON } from '../../../common/scalars/json.scalar';

/**
 * A single tool execution performed during an AI prompt — surfaced to the
 * frontend for transparency (what the assistant actually did).
 */
@ObjectType({ description: 'A tool action executed during an AI prompt' })
@Restricted(RoleEnum.S_EVERYONE)
export class CoreAiAction {
  /**
   * Arguments the tool was called with.
   */
  @Field(() => JSON, { description: 'Arguments the tool was called with', nullable: true })
  arguments?: Record<string, any>;

  /**
   * Name of the executed tool.
   */
  @Field(() => String, { description: 'Name of the executed tool' })
  name: string;

  /**
   * Result payload returned by the tool (already permission-filtered).
   */
  @Field(() => JSON, { description: 'Result returned by the tool', nullable: true })
  result?: unknown;

  /**
   * Whether the tool executed successfully.
   */
  @Field(() => Boolean, { description: 'Whether the tool executed successfully' })
  success: boolean;
}
