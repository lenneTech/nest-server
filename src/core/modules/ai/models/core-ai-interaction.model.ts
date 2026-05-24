import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema } from 'mongoose';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { JSON } from '../../../common/scalars/json.scalar';
import { CorePersistenceModel } from '../../../common/models/core-persistence.model';

export type AiInteractionDocument = CoreAiInteraction & Document;

/**
 * Audit record of a single AI prompt run.
 *
 * Persisted when `ai.audit` is enabled. Admin-only (compliance/debugging). The
 * per-user history surfaced to end users is the conversation feature, not this log.
 */
@MongooseSchema({ collection: 'aiInteractions', timestamps: true })
@ObjectType({ description: 'Audit record of an AI prompt run' })
@Restricted(RoleEnum.ADMIN)
export class CoreAiInteraction extends CorePersistenceModel {
  /**
   * Tool actions executed during the run (name + success).
   */
  @UnifiedField({
    description: 'Tool actions executed during the run',
    isOptional: true,
    mongoose: { type: Schema.Types.Mixed },
    roles: RoleEnum.ADMIN,
    type: () => JSON,
  })
  actions?: { name: string; success: boolean }[] = undefined;

  /**
   * Number of completion (output) tokens.
   */
  @UnifiedField({
    description: 'Number of completion tokens',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
    type: () => Number,
  })
  completionTokens?: number = undefined;

  /**
   * Id of the AI connection used.
   */
  @UnifiedField({
    description: 'Id of the AI connection used',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  connectionId?: string = undefined;

  /**
   * Number of agent-loop iterations.
   */
  @UnifiedField({
    description: 'Number of agent-loop iterations',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
    type: () => Number,
  })
  iterations?: number = undefined;

  /**
   * The prompt text.
   */
  @UnifiedField({
    description: 'The prompt text',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  prompt?: string = undefined;

  /**
   * Number of prompt (input) tokens.
   */
  @UnifiedField({
    description: 'Number of prompt tokens',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
    type: () => Number,
  })
  promptTokens?: number = undefined;

  /**
   * The natural-language answer returned to the user.
   */
  @UnifiedField({
    description: 'The natural-language answer returned to the user',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  responseText?: string = undefined;

  /**
   * Total number of tokens.
   */
  @UnifiedField({
    description: 'Total number of tokens',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
    type: () => Number,
  })
  totalTokens?: number = undefined;

  /**
   * Id of the user who ran the prompt.
   */
  @UnifiedField({
    description: 'Id of the user who ran the prompt',
    isOptional: true,
    mongoose: { index: true },
    roles: RoleEnum.ADMIN,
  })
  userId?: string = undefined;
}

export const AiInteractionSchema = SchemaFactory.createForClass(CoreAiInteraction);
