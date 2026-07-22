import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CorePersistenceModel } from '../../../common/models/core-persistence.model';

export type AiToolGrantDocument = CoreAiToolGrant & Document;

/**
 * Persistent permission decision so end users don't have to re-confirm the same
 * mutating action over and over. When the user confirms a mutating tool with
 * `prompt.input.rememberDecision: 'user' | 'tenant' | 'conversation'`, the
 * orchestrator persists a grant here. Subsequent calls to the same tool by the
 * same scope skip the confirmation gate — until the grant expires or an admin
 * revokes it.
 *
 * Grants only ever say "skip the confirmation gate" — they never relax the
 * permission model itself (`@Restricted`, `@Roles`, `securityCheck()` and scoped
 * tool-policies still apply). `destructive` tools are excluded from grants by
 * convention: irreversible actions always confirm.
 */
@MongooseSchema({ collection: 'aiToolGrants', timestamps: true })
@ObjectType({ description: 'Persistent permission decision for a mutating tool' })
@Restricted(RoleEnum.ADMIN)
export class CoreAiToolGrant extends CorePersistenceModel {
  /** Decision: only 'allow' is persisted today; 'deny' is reserved for future use. */
  @UnifiedField({
    description: "Decision ('allow' or 'deny')",
    isOptional: true,
    mongoose: { default: 'allow' },
    roles: RoleEnum.ADMIN,
  })
  decision?: string = undefined;

  /** Whether the grant is active (an admin can deactivate without deleting). */
  @UnifiedField({
    description: 'Whether the grant is active',
    isOptional: true,
    mongoose: { default: true },
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  enabled?: boolean = undefined;

  /** Optional TTL — when set, the grant auto-expires via a Mongo TTL index. */
  @UnifiedField({
    description: 'Optional expiry timestamp',
    isOptional: true,
    mongoose: { index: { expireAfterSeconds: 0 } },
    roles: RoleEnum.ADMIN,
    type: () => Date,
  })
  expiresAt?: Date = undefined;

  /**
   * Reference id for the scope: user id, tenant id, or conversation id.
   */
  @UnifiedField({
    description: 'Reference id for the scope (user/tenant/conversation id)',
    mongoose: { index: true },
    roles: RoleEnum.ADMIN,
  })
  refId: string = undefined;

  /** Scope: 'user' (this user, anywhere), 'tenant' (this tenant), 'conversation' (just this thread). */
  @UnifiedField({
    description: "Scope: 'user', 'tenant' or 'conversation'",
    mongoose: { index: true },
    roles: RoleEnum.ADMIN,
  })
  scope: string = undefined;

  /** The tool name this grant applies to. */
  @UnifiedField({
    description: 'Tool name the grant applies to',
    mongoose: { index: true },
    roles: RoleEnum.ADMIN,
  })
  tool: string = undefined;
}

export const AiToolGrantSchema = SchemaFactory.createForClass(CoreAiToolGrant);
// One active grant per (scope, refId, tool).
AiToolGrantSchema.index({ scope: 1, refId: 1, tool: 1 }, { unique: true });
