import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CorePersistenceModel } from '../../../common/models/core-persistence.model';

export type AiSlotDocument = CoreAiSlot & Document;

/**
 * Admin-editable building block of the SYSTEM prompt.
 *
 * The system prompt is assembled from keyed slots (see `CoreAiPromptBuilderService`):
 * each {@link key} is a logical slot (e.g. `base`, `permissions`, `anti_hallucination`,
 * `output_contract`, `tool_protocol_emulated`). The framework ships sensible built-in
 * defaults for every key, so the module works with zero rows; a row here **overrides**
 * the default for its key (optionally scoped by `locale`/`capability`).
 *
 * Tenancy: when multi-tenancy is active, an admin's slot is tenant-scoped — it only
 * applies to prompts running in that admin's tenant. Without multi-tenancy, slots are
 * effectively system-wide. The framework's built-in (`isSystem = true`) defaults are
 * NOT stored in this collection; admin "overrides" of a built-in are regular rows
 * matching the key.
 *
 * `content` may contain `{{placeholders}}` (see {@link CoreAiPlaceholderRegistry} for
 * the runtime-resolved list).
 */
@MongooseSchema({ collection: 'aiSlots', timestamps: true })
@ObjectType({ description: 'Admin-editable building block (fragment) of the AI system prompt' })
@Restricted(RoleEnum.ADMIN)
export class CoreAiSlot extends CorePersistenceModel {
  /**
   * Capability filter: 'all' (default), 'native' or 'emulated' — limits the slot
   * to runs with that tool-calling mode.
   */
  @UnifiedField({
    description: "Capability scope: 'all', 'native' or 'emulated'",
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  capability?: string = undefined;

  /**
   * Slot text. May contain `{{placeholders}}` (see placeholder registry).
   */
  @UnifiedField({
    description: 'Slot text — supports placeholder tokens; the active registry is served by GET /ai/placeholders',
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  content: string = undefined;

  /**
   * Admin-facing description of what this slot does.
   */
  @UnifiedField({
    description: 'Admin-facing description of the slot',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  description?: string = undefined;

  /**
   * Whether the slot is active (disabled slots are skipped — used to "hide" a
   * built-in default for a specific tenant without losing the row).
   */
  @UnifiedField({
    description: 'Whether the slot is included in the prompt',
    isOptional: true,
    mongoose: { default: true },
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  enabled?: boolean = undefined;

  /**
   * Logical slot key (e.g. `base`, `permissions`, `anti_hallucination`).
   * A row whose `key` matches a built-in system slot overrides it for the slot's tenant.
   */
  @UnifiedField({
    description: "Logical prompt slot key (e.g. 'base', 'permissions', 'anti_hallucination')",
    mongoose: { index: true },
    roles: RoleEnum.ADMIN,
  })
  key: string = undefined;

  /**
   * Optional locale ('en', 'de', …). When set, the slot is only used for that
   * language; otherwise it applies to all languages.
   */
  @UnifiedField({
    description: "Locale (e.g. 'en', 'de'); empty = all languages",
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  locale?: string = undefined;

  /**
   * Assembly order (ascending). Lower numbers appear earlier in the prompt.
   */
  @UnifiedField({
    description: 'Assembly order (ascending)',
    isOptional: true,
    mongoose: { default: 100 },
    roles: RoleEnum.ADMIN,
    type: () => Number,
  })
  order?: number = undefined;

  /**
   * Optional scope-filter this slot applies to. Empty/undefined = always applies.
   * Recognized prefixes: `tool:<name>` (only when that tool is in scope), `role:<name>`
   * (only when the user has that role), `mode:<name>` (only when running in this named
   * mode — see {@link CoreAiMode}). Multiple filters can be expressed by creating
   * multiple rows with the same key.
   */
  @UnifiedField({
    description: "Scope filter (e.g. 'tool:get_user', 'role:admin', 'mode:support'); empty = always",
    isOptional: true,
    mongoose: { index: true },
    roles: RoleEnum.ADMIN,
  })
  scope?: string = undefined;

  /**
   * Tenant id the slot applies to. Auto-set from the creating admin's tenant when
   * multi-tenancy is active. Without multi-tenancy this stays undefined and the
   * slot is effectively system-wide.
   */
  @UnifiedField({
    description: 'Tenant id the slot applies to (auto-set; undefined = system-wide)',
    isOptional: true,
    mongoose: { index: true },
    roles: RoleEnum.ADMIN,
  })
  tenantId?: string = undefined;
}

export const AiSlotSchema = SchemaFactory.createForClass(CoreAiSlot);
// Compound index for the common lookup (effective slots by key + locale + capability + tenant).
AiSlotSchema.index({ key: 1, locale: 1, capability: 1, tenantId: 1 });
