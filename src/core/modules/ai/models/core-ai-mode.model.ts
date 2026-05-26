import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CorePersistenceModel } from '../../../common/models/core-persistence.model';

export type AiModeDocument = CoreAiMode & Document;

/**
 * Admin-editable **named agent mode** — bundles a curated prompt scope, a
 * restricted tool set, an optional model override, and optional role
 * restrictions under a name like `support`, `audit`, `billing`. Activated by
 * setting `CoreAiPromptInput.mode` to the mode's `name`.
 *
 * Modes are an opinionated, end-user-friendly way for admins to ship
 * domain-specialized assistants without forking the orchestrator. Like every
 * other ai layer, modes can only ADD restrictions; they cannot relax the
 * permission model (`@Restricted` / `@Roles` / `authorize()` still apply).
 */
@MongooseSchema({ collection: 'aiModes', timestamps: true })
@ObjectType({ description: 'Named agent mode' })
@Restricted(RoleEnum.ADMIN)
export class CoreAiMode extends CorePersistenceModel {
  /** Restrict the assistant to this whitelist of tool names. Empty = all role-permitted tools. */
  @UnifiedField({
    description: 'Whitelist of tool names available in this mode (empty = all role-permitted tools)',
    isOptional: true,
    mongoose: { default: [] },
    roles: RoleEnum.ADMIN,
    type: () => [String],
  })
  allowedTools?: string[] = undefined;

  /** Force a specific LLM connection (overrides the resolution chain). */
  @UnifiedField({
    description: 'Force a specific LLM connection id when this mode is active',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  connectionId?: string = undefined;

  /** Admin-facing description shown in any mode picker. */
  @UnifiedField({
    description: 'Admin-facing description',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  description?: string = undefined;

  /** Whether the mode is active. */
  @UnifiedField({
    description: 'Whether the mode is enabled',
    isOptional: true,
    mongoose: { default: true },
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  enabled?: boolean = undefined;

  /** Unique mode name (used as `input.mode`). */
  @UnifiedField({
    description: 'Unique mode name',
    mongoose: { unique: true },
    roles: RoleEnum.ADMIN,
  })
  name: string = undefined;

  /** Optional system-prompt override appended to the assembled base prompt. */
  @UnifiedField({
    description: 'Optional system-prompt addendum injected when the mode is active',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  promptAddendum?: string = undefined;

  /** Restrict mode activation to users who have at least one of these roles. */
  @UnifiedField({
    description: 'Restrict the mode to users with at least one of these roles',
    isOptional: true,
    mongoose: { default: [] },
    roles: RoleEnum.ADMIN,
    type: () => [String],
  })
  roles?: string[] = undefined;
}

export const AiModeSchema = SchemaFactory.createForClass(CoreAiMode);
