import { InputType } from '@nestjs/graphql';
import { IsInt, Min } from 'class-validator';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';

/**
 * Input to update an AI connection. All fields are optional (patch semantics).
 *
 * HINT: All properties must be initialized with `undefined` so they are picked up
 * via `Object.keys` for mapping and never overwrite existing DB values.
 */
@InputType({ description: 'Input to update an AI connection', isAbstract: true })
@Restricted(RoleEnum.ADMIN)
export class CoreAiConnectionInput {
  /**
   * Plaintext API key. Encrypted at rest, never returned. Pass an empty string
   * to clear the stored key; omit the field to leave it untouched.
   */
  @UnifiedField({
    description: 'Plaintext API key (encrypted at rest, never returned; empty string clears it)',
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  apiKey?: string = undefined;

  /**
   * Name of an environment variable used as API-key fallback.
   */
  @UnifiedField({
    description: 'Name of the environment variable used as API-key fallback',
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  apiKeyEnv?: string = undefined;

  /**
   * Base URL of the OpenAI-compatible endpoint.
   */
  @UnifiedField({
    description: 'Base URL of the OpenAI-compatible endpoint',
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  baseUrl?: string = undefined;

  /**
   * Capability tags of the model.
   */
  @UnifiedField({
    description: 'Capability tags of the model',
    isArray: true,
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => String,
  })
  capabilities?: string[] = undefined;

  /**
   * Default maximum number of tokens for completions.
   */
  @UnifiedField({
    description: 'Default maximum number of tokens for completions',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Number,
  })
  defaultMaxTokens?: number = undefined;

  @UnifiedField({
    description: 'Total context window (tokens) the model supports; enables context-overflow handling',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Number,
    validator: (options) => [IsInt(options), Min(1, options)],
  })
  contextWindow?: number = undefined;

  /**
   * Default sampling temperature for completions.
   */
  @UnifiedField({
    description: 'Default sampling temperature for completions',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Number,
  })
  defaultTemperature?: number = undefined;

  /** Provider-side soft user quota (tokens) used when no hard budget is set. */
  @UnifiedField({
    description: 'Provider-side soft user quota (tokens) used when no hard budget is set',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Number,
  })
  defaultUserMaxTokens?: number = undefined;

  /** Period for the provider-side soft user quota (`day` | `month` | `none`). */
  @UnifiedField({
    description: 'Period for the provider-side soft user quota (day | month | none)',
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  defaultUserMaxPeriod?: string = undefined;

  /**
   * Human-readable description.
   */
  @UnifiedField({
    description: 'Human-readable description of the connection',
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  description?: string = undefined;

  /**
   * Whether the connection is enabled.
   */
  @UnifiedField({
    description: 'Whether the connection is enabled',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  enabled?: boolean = undefined;

  /**
   * Admin-enforced for all tenants (overrides user/client/tenant selection).
   */
  @UnifiedField({
    description: 'Admin-enforced for all tenants',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  enforced?: boolean = undefined;

  /**
   * Tenant ids for which this connection is admin-enforced.
   */
  @UnifiedField({
    description: 'Tenant ids for which this connection is admin-enforced',
    isArray: true,
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => String,
  })
  enforcedTenantIds?: string[] = undefined;

  /**
   * Whether this is the default connection.
   */
  @UnifiedField({
    description: 'Whether this is the default connection',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  isDefault?: boolean = undefined;

  /**
   * Model id sent to the backend.
   */
  @UnifiedField({
    description: 'Model id sent to the backend (e.g. gpt-oss-120b)',
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  model?: string = undefined;

  /**
   * Human-readable connection name.
   */
  @UnifiedField({
    description: 'Human-readable connection name',
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  name?: string = undefined;

  /**
   * Provider type.
   */
  @UnifiedField({
    description: 'Provider type (e.g. openai-compatible)',
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  providerType?: string = undefined;

  /**
   * Whether the backend supports native JSON/structured-output mode.
   */
  @UnifiedField({
    description: 'Whether the backend supports native JSON/structured-output mode',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  supportsJsonResponse?: boolean = undefined;

  /**
   * Whether the backend supports native function/tool calling.
   */
  @UnifiedField({
    description: 'Whether the backend supports native function/tool calling',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  supportsNativeTools?: boolean = undefined;

  /**
   * Whether the model supports vision (image input).
   */
  @UnifiedField({
    description: 'Whether the model supports vision (image input)',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  supportsVision?: boolean = undefined;

  /**
   * Tenant ids this connection is available to (empty = all tenants).
   */
  @UnifiedField({
    description: 'Tenant ids this connection is available to (empty = all tenants)',
    isArray: true,
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => String,
  })
  tenantIds?: string[] = undefined;
}
