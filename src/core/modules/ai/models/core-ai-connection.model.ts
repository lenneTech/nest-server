import { ObjectType } from '@nestjs/graphql';
import { Prop, Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CorePersistenceModel } from '../../../common/models/core-persistence.model';

export type AiConnectionDocument = CoreAiConnection & Document;

/**
 * Persisted configuration for an LLM connection (provider endpoint + model + key).
 *
 * Connections are the database-backed configuration the user emphasized: admins
 * manage them at runtime (later via a frontend settings area) instead of editing
 * `config.env.ts`. The API key is encrypted at rest ({@link AiCryptoService}) and
 * NEVER returned through the API — only {@link hasApiKey} is exposed.
 *
 * The whole model is restricted to {@link RoleEnum.ADMIN}: only administrators may
 * read or manage connections.
 */
@MongooseSchema({ collection: 'aiConnections', timestamps: true })
@ObjectType({ description: 'AI connection configuration (LLM provider endpoint, model and credentials)' })
@Restricted(RoleEnum.ADMIN)
export class CoreAiConnection extends CorePersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * AES-256-GCM-encrypted API key (`iv.tag.ciphertext`).
   *
   * Mongoose-only: NOT a GraphQL field, so it never appears in the GraphQL schema.
   * It is read internally by the service (e.g. {@link CoreAiConnectionService.resolve})
   * and stripped from every HTTP response by two layers: {@link securityCheck}
   * (which also derives {@link hasApiKey}) and the global `secretFields` list
   * (`apiKeyEncrypted` is a registered secret field). It deliberately carries no
   * `@Restricted` so it survives the service `checkRestricted` step long enough for
   * {@link securityCheck} to compute {@link hasApiKey}.
   */
  @Prop()
  apiKeyEncrypted?: string = undefined;

  /**
   * Name of an environment variable used as API-key fallback when no key is
   * stored in the database (e.g. 'AI_API_KEY').
   */
  @UnifiedField({
    description: 'Name of the environment variable used as API-key fallback',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  apiKeyEnv?: string = undefined;

  /**
   * Base URL of the OpenAI-compatible endpoint.
   */
  @UnifiedField({
    description: 'Base URL of the OpenAI-compatible endpoint (e.g. https://llm.example.com/v1)',
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  baseUrl: string = undefined;

  /**
   * Free-form capability tags (e.g. 'analysis', 'ocr', 'both') for routing/UI.
   */
  @UnifiedField({
    description: 'Capability tags of the model (free-form, e.g. analysis, ocr, vision)',
    isArray: true,
    isOptional: true,
    mongoose: [String],
    roles: RoleEnum.ADMIN,
    type: () => String,
  })
  capabilities?: string[] = undefined;

  /**
   * Default maximum number of tokens for completions on this connection.
   */
  @UnifiedField({
    description: 'Default maximum number of tokens for completions',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
    type: () => Number,
  })
  defaultMaxTokens?: number = undefined;

  /**
   * Default sampling temperature for completions on this connection.
   */
  @UnifiedField({
    description: 'Default sampling temperature for completions',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
    type: () => Number,
  })
  defaultTemperature?: number = undefined;

  /**
   * Human-readable description.
   */
  @UnifiedField({
    description: 'Human-readable description of the connection',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  description?: string = undefined;

  /**
   * Whether the connection is active and may be used.
   */
  @UnifiedField({
    description: 'Whether the connection is enabled',
    isOptional: true,
    mongoose: { default: true },
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  enabled?: boolean = undefined;

  /**
   * Admin-enforced globally: when true, this connection is mandated for all tenants
   * and overrides any user/client/tenant selection (resolution layer 6).
   */
  @UnifiedField({
    description: 'Admin-enforced for all tenants (overrides user/client/tenant selection)',
    isOptional: true,
    mongoose: { default: false },
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  enforced?: boolean = undefined;

  /**
   * Admin-enforced for specific tenants: this connection is mandated for the listed
   * tenants (resolution layer 7, the most specific admin mandate).
   */
  @UnifiedField({
    description: 'Tenant ids for which this connection is admin-enforced',
    isArray: true,
    isOptional: true,
    mongoose: [String],
    roles: RoleEnum.ADMIN,
    type: () => String,
  })
  enforcedTenantIds?: string[] = undefined;

  /**
   * Whether an encrypted API key is currently stored. Computed, read-only;
   * the plaintext key is never returned.
   */
  @UnifiedField({
    description: 'Whether an API key is currently stored (the key itself is never returned)',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  hasApiKey?: boolean = undefined;

  /**
   * Whether this is the default connection used when no connection is specified.
   */
  @UnifiedField({
    description: 'Whether this is the default connection',
    isOptional: true,
    mongoose: { default: false },
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  isDefault?: boolean = undefined;

  /**
   * Model id sent to the backend (e.g. 'gpt-oss-120b').
   */
  @UnifiedField({
    description: 'Model id sent to the backend (e.g. gpt-oss-120b)',
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  model: string = undefined;

  /**
   * Human-readable connection name.
   */
  @UnifiedField({
    description: 'Human-readable connection name',
    mongoose: { trim: true },
    roles: RoleEnum.ADMIN,
  })
  name: string = undefined;

  /**
   * Provider implementation key (decides which provider builder is used).
   */
  @UnifiedField({
    description: 'Provider type (e.g. openai-compatible)',
    isOptional: true,
    mongoose: { default: 'openai-compatible' },
    roles: RoleEnum.ADMIN,
  })
  providerType?: string = undefined;

  /**
   * Whether the backend natively supports JSON / structured-output mode.
   * When false, JSON is requested via the prompt and parsed defensively.
   * Leave UNDEFINED to auto-detect on first use / on save (no mongoose default,
   * so "not set" stays distinguishable from an explicit false).
   */
  @UnifiedField({
    description: 'Whether the backend supports native JSON/structured-output mode (undefined = auto-detect)',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  supportsJsonResponse?: boolean = undefined;

  /**
   * Whether the backend natively supports function/tool calling. When false, tool
   * calling is emulated via the system prompt. Leave UNDEFINED to auto-detect
   * (no mongoose default, so "not set" stays distinguishable from an explicit false).
   */
  @UnifiedField({
    description: 'Whether the backend supports native function/tool calling (undefined = auto-detect)',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  supportsNativeTools?: boolean = undefined;

  /**
   * Whether the model can process images.
   */
  @UnifiedField({
    description: 'Whether the model supports vision (image input)',
    isOptional: true,
    mongoose: { default: false },
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  supportsVision?: boolean = undefined;

  /**
   * Tenants this connection is available to. Empty/undefined = available to ALL
   * tenants (the global pool); otherwise restricted to the listed tenants. This is
   * the per-tenant availability restriction of the overall selection.
   */
  @UnifiedField({
    description: 'Tenant ids this connection is available to (empty = all tenants)',
    isArray: true,
    isOptional: true,
    mongoose: [String],
    roles: RoleEnum.ADMIN,
    type: () => String,
  })
  tenantIds?: string[] = undefined;

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Compute the non-secret {@link hasApiKey} indicator and strip the encrypted
   * key from every output. Runs via the CheckSecurityInterceptor on responses.
   */
  override securityCheck(user?: any, force?: boolean) {
    this.hasApiKey = !!this.apiKeyEncrypted;
    this.apiKeyEncrypted = undefined;
    // Access to the whole model is already gated by @Restricted(ADMIN); nothing
    // else to filter here. `force` and `user` are kept for signature symmetry.
    void force;
    void user;
    return this;
  }
}

export const AiConnectionSchema = SchemaFactory.createForClass(CoreAiConnection);
