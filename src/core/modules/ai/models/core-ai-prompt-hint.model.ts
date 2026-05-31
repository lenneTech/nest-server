import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CorePersistenceModel } from '../../../common/models/core-persistence.model';

export type AiPromptHintDocument = CoreAiPromptHint & Document;

/**
 * A learned prompt hint produced by the governed self-improvement loop
 * ({@link CoreAiPromptFeedbackService}). When a recurring failure pattern is detected
 * (tool errors, denied actions, parse failures, claimed-but-not-executed actions),
 * a hint is recorded and, once **approved** (or auto-approved when
 * `ai.promptLearning.autoApply` is on), injected into the system prompt so the model
 * avoids the same mistake next time.
 *
 * Hints only ever ADD guidance — they can never relax the security core (permissions,
 * tool gating), which is always enforced backend-side independently of the prompt.
 */
@MongooseSchema({ collection: 'aiPromptHints', timestamps: true })
@ObjectType({ description: 'Learned AI prompt hint from the governed self-improvement loop' })
@Restricted(RoleEnum.ADMIN)
export class CoreAiPromptHint extends CorePersistenceModel {
  /**
   * The guidance text injected into the prompt when approved + enabled.
   */
  @UnifiedField({
    description: 'Guidance text added to the prompt when approved',
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  content: string = undefined;

  /**
   * Whether the hint is active (independent of approval status).
   */
  @UnifiedField({
    description: 'Whether the hint is active',
    isOptional: true,
    mongoose: { default: true },
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  enabled?: boolean = undefined;

  /**
   * How often the underlying failure pattern was observed.
   */
  @UnifiedField({
    description: 'Number of times the failure pattern was observed',
    isOptional: true,
    mongoose: { default: 1 },
    roles: RoleEnum.ADMIN,
    type: () => Number,
  })
  occurrences?: number = undefined;

  /**
   * Optional scope the hint applies to (e.g. a tool name); empty = global.
   */
  @UnifiedField({
    description: 'Scope the hint applies to (e.g. a tool name); empty = global',
    isOptional: true,
    mongoose: { index: true },
    roles: RoleEnum.ADMIN,
  })
  scope?: string = undefined;

  /**
   * Governance status: 'suggested' (default), 'approved' or 'rejected'. Only
   * 'approved' + enabled hints reach the prompt.
   */
  @UnifiedField({
    description: "Governance status: 'suggested', 'approved' or 'rejected'",
    isOptional: true,
    mongoose: { default: 'suggested', index: true },
    roles: RoleEnum.ADMIN,
  })
  status?: string = undefined;

  /**
   * Failure-pattern identifier that produced this hint (e.g. 'tool_error',
   * 'hallucinated_execution', 'parse_failure', 'denied').
   */
  @UnifiedField({
    description: 'Failure-pattern identifier that produced the hint',
    mongoose: { index: true },
    roles: RoleEnum.ADMIN,
  })
  trigger: string = undefined;
}

export const AiPromptHintSchema = SchemaFactory.createForClass(CoreAiPromptHint);
// One aggregated hint per (trigger, scope).
AiPromptHintSchema.index({ scope: 1, trigger: 1 }, { unique: true });
