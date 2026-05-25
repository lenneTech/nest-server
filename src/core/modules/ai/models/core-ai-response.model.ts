import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { JSON } from '../../../common/scalars/json.scalar';
import { CoreAiAction } from './core-ai-action.model';
import { CoreAiBudgetSummary } from './core-ai-usage-info.model';
import { CoreAiUsage } from './core-ai-usage.model';

/**
 * Structured response of an AI prompt.
 *
 * The frontend renders {@link text} as the natural-language answer, may render
 * {@link data} as structured output (tables/cards), and can show {@link actions}
 * for transparency about what the assistant did.
 */
@ObjectType({ description: 'Structured response of an AI prompt' })
@Restricted(RoleEnum.S_EVERYONE)
export class CoreAiResponse {
  /**
   * Tool actions executed while answering.
   */
  @Field(() => [CoreAiAction], { description: 'Tool actions executed while answering', nullable: true })
  actions?: CoreAiAction[];

  /**
   * Compact token-budget summary (this prompt's cost, remaining/used, reset time).
   */
  @Field(() => CoreAiBudgetSummary, { description: 'Compact token-budget summary', nullable: true })
  budget?: CoreAiBudgetSummary;

  /**
   * Id of the AI connection used.
   */
  @Field(() => String, { description: 'Id of the AI connection used', nullable: true })
  connectionId?: string;

  /**
   * Conversation id for multi-turn continuation.
   */
  @Field(() => String, { description: 'Conversation id for multi-turn continuation', nullable: true })
  conversationId?: string;

  /**
   * Whether the run was aborted because the user lacked permission for at least
   * one planned action (plan mode, all-or-nothing). Nothing was executed.
   */
  @Field(() => Boolean, { description: 'Whether the run was aborted due to missing permissions', nullable: true })
  denied?: boolean;

  /**
   * Planned actions the user is NOT permitted to perform (when `denied`).
   */
  @Field(() => [CoreAiAction], { description: 'Planned actions the user may not perform', nullable: true })
  deniedActions?: CoreAiAction[];

  /**
   * Optional structured data the frontend can render.
   */
  @Field(() => JSON, { description: 'Optional structured data for the frontend to render', nullable: true })
  data?: unknown;

  /**
   * Number of agent-loop iterations performed.
   */
  @Field(() => Int, { description: 'Number of agent-loop iterations performed', nullable: true })
  iterations?: number;

  /**
   * The planned actions (plan mode), for transparency.
   */
  @Field(() => [CoreAiAction], { description: 'Planned actions (plan mode)', nullable: true })
  plan?: CoreAiAction[];

  /**
   * Mutating/destructive tool actions awaiting confirmation. Re-send the prompt
   * with `confirm: true` to execute them.
   */
  @Field(() => [CoreAiAction], {
    description: 'Actions awaiting confirmation',
    nullable: true,
  })
  pendingActions?: CoreAiAction[];

  /**
   * Whether the response is awaiting confirmation of destructive actions.
   */
  @Field(() => Boolean, { description: 'Whether confirmation of destructive actions is required', nullable: true })
  requiresConfirmation?: boolean;

  /**
   * Natural-language answer for the user.
   */
  @Field(() => String, { description: 'Natural-language answer for the user' })
  text: string;

  /**
   * Token usage (best effort).
   */
  @Field(() => CoreAiUsage, { description: 'Token usage (best effort)', nullable: true })
  usage?: CoreAiUsage;
}
