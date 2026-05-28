import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CorePersistenceModel } from '../../../common/models/core-persistence.model';

export type AiPromptDocument = CoreAiPrompt & Document;

/**
 * User-facing prompt — a short, named piece of text the user can insert into
 * the chat input with one click. Different from the {@link CoreAiPromptInput}
 * mutation payload (which carries a single user question to the AI) and from
 * {@link CoreAiSlot} (the admin-edited building blocks of the SYSTEM prompt).
 *
 * Visibility (enforced in {@link CoreAiPromptService.listVisible} + this
 * model's {@link securityCheck}):
 * - `scope: 'user'`   → only the `ownerId` user sees it ("private").
 * - `scope: 'tenant'` → all members of `tenantId` see it ("public" within
 *   the tenant; without multi-tenancy this is effectively workspace-wide).
 *
 * Mutations are owner-only.
 */
@MongooseSchema({ collection: 'aiPrompts', timestamps: true })
@ObjectType({ description: 'User-facing AI prompt (re-usable user prompt)' })
@Restricted(RoleEnum.S_USER)
export class CoreAiPrompt extends CorePersistenceModel {
  /** The text inserted into the chat input. May contain `{{placeholders}}`. */
  @UnifiedField({ description: 'The prompt text', mongoose: true, roles: RoleEnum.S_USER })
  content: string = undefined;

  /** Optional description. */
  @UnifiedField({ description: 'Description', isOptional: true, mongoose: true, roles: RoleEnum.S_USER })
  description?: string = undefined;

  /** Whether the prompt is active (disabled prompts are hidden from the picker). */
  @UnifiedField({
    description: 'Whether the prompt is active',
    isOptional: true,
    mongoose: { default: true },
    roles: RoleEnum.S_USER,
    type: () => Boolean,
  })
  enabled?: boolean = undefined;

  /** Optional icon hint for the UI (lucide name or single emoji). */
  @UnifiedField({
    description: 'Icon hint (e.g. lucide name or emoji)',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.S_USER,
  })
  icon?: string = undefined;

  /** Display label shown in the prompt picker. */
  @UnifiedField({ description: 'Display label', mongoose: { index: true }, roles: RoleEnum.S_USER })
  name: string = undefined;

  /** Owner user id (the creator). Set automatically on create. */
  @UnifiedField({
    description: 'Owner user id',
    mongoose: { index: true },
    roles: RoleEnum.S_USER,
  })
  ownerId: string = undefined;

  /** Sort order in the picker (ascending). */
  @UnifiedField({
    description: 'Sort order',
    isOptional: true,
    mongoose: { default: 100 },
    roles: RoleEnum.S_USER,
    type: () => Number,
  })
  order?: number = undefined;

  /**
   * Visibility scope: `'user'` (only the owner — "private") or `'tenant'`
   * (members of the owner's tenant — "public").
   */
  @UnifiedField({
    description: "Visibility scope ('user' = private, 'tenant' = public)",
    mongoose: { default: 'user', index: true },
    roles: RoleEnum.S_USER,
  })
  scope: string = undefined;

  /** Tenant id when scope = 'tenant' (set from the creator's tenant at create time). */
  @UnifiedField({
    description: 'Tenant id (when scope = "tenant")',
    isOptional: true,
    mongoose: { index: true },
    roles: RoleEnum.S_USER,
  })
  tenantId?: string = undefined;

  /**
   * Filter prompts out of read responses the current user is not allowed to see.
   * Update/delete authorization is enforced by the service layer.
   */
  override securityCheck(user: any, _force?: boolean): this {
    if (!user) {
      return undefined as any;
    }
    if (this.scope === 'tenant') {
      const userTenantId = user.tenantId || user.currentTenantId || (user.tenantIds || [])[0];
      if (this.ownerId === user.id || (this.tenantId && this.tenantId === String(userTenantId))) {
        return this;
      }
      return undefined as any;
    }
    return this.ownerId === user.id ? this : (undefined as any);
  }
}

export const AiPromptSchema = SchemaFactory.createForClass(CoreAiPrompt);
// One prompt per (owner, name) — keeps the picker tidy.
AiPromptSchema.index({ ownerId: 1, name: 1 }, { unique: true });
