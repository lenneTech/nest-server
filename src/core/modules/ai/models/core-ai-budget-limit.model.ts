import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CorePersistenceModel } from '../../../common/models/core-persistence.model';

export type AiBudgetLimitDocument = CoreAiBudgetLimit & Document;

/**
 * Admin-configured token/prompt limit override for a specific user or tenant.
 *
 * Overrides the config defaults (`ai.budget.user` / `ai.budget.tenant`). A missing
 * or `0`/undefined `maxTokens`/`maxPrompts` means unlimited for that dimension.
 * Deliberately has NO `tenantId` path so it is NOT tenant-scoped — admins manage
 * all limits globally.
 */
@MongooseSchema({ collection: 'aiBudgetLimits', timestamps: true })
@ObjectType({ description: 'Admin-configured AI token/prompt limit for a user or tenant' })
@Restricted(RoleEnum.ADMIN)
export class CoreAiBudgetLimit extends CorePersistenceModel {
  /**
   * Maximum number of prompts per reset period (undefined/0 = unlimited).
   */
  @UnifiedField({
    description: 'Maximum number of prompts per reset period (0/undefined = unlimited)',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
    type: () => Number,
  })
  maxPrompts?: number = undefined;

  /**
   * Maximum number of tokens per reset period (undefined/0 = unlimited).
   */
  @UnifiedField({
    description: 'Maximum number of tokens per reset period (0/undefined = unlimited)',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
    type: () => Number,
  })
  maxTokens?: number = undefined;

  /**
   * Reset period: 'day', 'month' or 'none' (no reset). Defaults to the config period.
   */
  @UnifiedField({
    description: "Reset period: 'day', 'month' or 'none'",
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  period?: string = undefined;

  /**
   * Id of the user or tenant this limit applies to.
   */
  @UnifiedField({
    description: 'Id of the user or tenant this limit applies to',
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  refId: string = undefined;

  /**
   * Scope of the limit: 'user' or 'tenant'.
   */
  @UnifiedField({
    description: "Scope of the limit: 'user' or 'tenant'",
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  scope: string = undefined;
}

export const AiBudgetLimitSchema = SchemaFactory.createForClass(CoreAiBudgetLimit);
// Compound index: one limit per (scope, refId).
AiBudgetLimitSchema.index({ scope: 1, refId: 1 }, { unique: true });
