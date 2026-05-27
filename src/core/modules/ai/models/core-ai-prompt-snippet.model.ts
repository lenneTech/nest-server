import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CorePersistenceModel } from '../../../common/models/core-persistence.model';

export type AiPromptSnippetDocument = CoreAiPromptSnippet & Document;

/**
 * User-facing prompt snippet (also called "Vorlage" in the UI) — a short, named
 * piece of text the user can insert into the chat input with one click.
 *
 * Different from {@link CoreAiPromptTemplate}: that one is an admin-only
 * building block of the SYSTEM prompt; this one is a user-created USER-prompt
 * preset (e.g. "Erkläre den letzten Fehler", "Schreibe eine kurze Antwort an
 * den Kunden zu …", …). Users may create snippets for themselves, share them
 * with their tenant, or — when multi-tenancy is off — make them available to
 * everyone in the workspace.
 *
 * Visibility rules (enforced in {@link CoreAiPromptSnippetService.find} and the
 * model's {@link securityCheck}):
 * - `scope: 'user'`   → only the `ownerId` user sees it.
 * - `scope: 'tenant'` → all members of `tenantId` see it.
 * - `scope: 'global'` → all signed-in users see it.
 *
 * Write/delete is always restricted to the owner (admins can still delete via
 * the standard admin pipeline).
 */
@MongooseSchema({ collection: 'aiPromptSnippets', timestamps: true })
@ObjectType({ description: 'User-facing prompt snippet (Vorlage)' })
@Restricted(RoleEnum.S_USER)
export class CoreAiPromptSnippet extends CorePersistenceModel {
  /** The text inserted into the chat input. May contain `{{placeholders}}`. */
  @UnifiedField({ description: 'The snippet text', mongoose: true, roles: RoleEnum.S_USER })
  content: string = undefined;

  /** Optional admin-facing description. */
  @UnifiedField({ description: 'Description', isOptional: true, mongoose: true, roles: RoleEnum.S_USER })
  description?: string = undefined;

  /** Whether the snippet is active (disabled snippets are hidden from the picker). */
  @UnifiedField({
    description: 'Whether the snippet is active',
    isOptional: true,
    mongoose: { default: true },
    roles: RoleEnum.S_USER,
    type: () => Boolean,
  })
  enabled?: boolean = undefined;

  /** Optional icon hint for the UI (e.g. lucide name or single emoji). */
  @UnifiedField({
    description: 'Icon hint (e.g. lucide name or emoji)',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.S_USER,
  })
  icon?: string = undefined;

  /** Display label shown in the snippet picker. */
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
   * Visibility scope: `'user'` (only the owner), `'tenant'` (members of the
   * owner's tenant), or `'global'` (every signed-in user).
   */
  @UnifiedField({
    description: "Visibility scope ('user', 'tenant' or 'global')",
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
   * Filter snippets out of read responses the current user is not allowed to see.
   * Update/delete authorization is enforced by the service layer.
   */
  override securityCheck(user: any, _force?: boolean): this {
    if (!user) {
      return undefined as any;
    }
    if (this.scope === 'global') {
      return this;
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

export const AiPromptSnippetSchema = SchemaFactory.createForClass(CoreAiPromptSnippet);
// One snippet per (owner, name) — keeps the picker tidy and the user can't
// shadow their own snippet by accident.
AiPromptSnippetSchema.index({ ownerId: 1, name: 1 }, { unique: true });
