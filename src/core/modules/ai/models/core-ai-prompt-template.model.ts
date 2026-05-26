import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CorePersistenceModel } from '../../../common/models/core-persistence.model';

export type AiPromptTemplateDocument = CoreAiPromptTemplate & Document;

/**
 * Admin-editable building block of the system prompt.
 *
 * The prompt is assembled from keyed fragments (see `CoreAiPromptBuilderService`):
 * each {@link key} is a logical slot (e.g. `base`, `permissions`, `anti_hallucination`,
 * `output_contract`, `tool_protocol_emulated`). The service ships sensible built-in
 * defaults for every key, so the module works with zero rows; a row here **overrides**
 * the default for its key (optionally scoped by `locale`/`capability`). This keeps the
 * prompt fully transparent and adjustable — by admins AND by the governed learning
 * loop — instead of hard-coding it in TypeScript.
 *
 * `content` may contain `{{placeholders}}` rendered at build time
 * (`{{roles}}`, `{{tools}}`, `{{toolCatalog}}`, `{{documentation}}`, `{{learnedHints}}`,
 * `{{userId}}`).
 */
@MongooseSchema({ collection: 'aiPromptTemplates', timestamps: true })
@ObjectType({ description: 'Admin-editable building block (fragment) of the AI system prompt' })
@Restricted(RoleEnum.ADMIN)
export class CoreAiPromptTemplate extends CorePersistenceModel {
  /**
   * Capability scope: 'all' (default), 'native' or 'emulated' — limits the fragment
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
   * Fragment text. May contain `{{placeholders}}` rendered at build time.
   */
  @UnifiedField({
    description: 'Fragment text (supports {{placeholders}})',
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  content: string = undefined;

  /**
   * Admin-facing description of what this fragment does.
   */
  @UnifiedField({
    description: 'Admin-facing description of the fragment',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  description?: string = undefined;

  /**
   * Whether the fragment is active (disabled fragments are skipped).
   */
  @UnifiedField({
    description: 'Whether the fragment is included in the prompt',
    isOptional: true,
    mongoose: { default: true },
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  enabled?: boolean = undefined;

  /**
   * Logical slot this fragment fills (e.g. 'base', 'permissions', 'anti_hallucination').
   */
  @UnifiedField({
    description: "Logical prompt slot (e.g. 'base', 'permissions', 'anti_hallucination')",
    mongoose: { index: true },
    roles: RoleEnum.ADMIN,
  })
  key: string = undefined;

  /**
   * Optional locale ('en', 'de', …). When set, the fragment is only used for that
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
}

export const AiPromptTemplateSchema = SchemaFactory.createForClass(CoreAiPromptTemplate);
// Compound index for the common lookup (effective fragments by key + locale + capability).
AiPromptTemplateSchema.index({ key: 1, locale: 1, capability: 1 });
