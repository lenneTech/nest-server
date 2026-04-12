import { registerEnumType } from '@nestjs/graphql';

import { enumNameRegistry } from '../decorators/unified-field.decorator';

/**
 * Tracks which enum objects have been registered for GraphQL via registerEnum/registerEnums.
 * Used to prevent duplicate registerEnumType() calls which cause schema build errors.
 * Separate from enumNameRegistry (Swagger) because GraphQL registration is a distinct concern.
 *
 * @internal Consumers should use {@link enumNameRegistry} (from unified-field.decorator) to
 * verify Swagger/name registration. This registry is exported for advanced use cases
 * (e.g. checking if an enum is already registered for GraphQL before calling registerEnumType
 * directly), but most projects should not need to interact with it.
 */
export const graphqlEnumRegistry = new WeakSet<object>();

/**
 * Interface defining options for the registerEnum helper
 */
export interface RegisterEnumOptions<T extends object = any> {
  /**
   * Description of the enum
   */
  description?: string;

  /**
   * Whether to register the enum for GraphQL using registerEnumType
   * @default true
   */
  graphql?: boolean;

  /**
   * Name of the enum (required)
   */
  name: string;

  /**
   * Whether to register the enum in the enumNameRegistry for Swagger/REST
   * @default true
   */
  swagger?: boolean;

  /**
   * A map of options for the values of the enum (only used for GraphQL)
   */
  valuesMap?: Partial<Record<keyof T, { deprecationReason?: string; description?: string }>>;
}

/**
 * Registers an enum for both GraphQL and Swagger/REST APIs.
 *
 * This is a convenience helper that combines:
 * - `registerEnumType` from @nestjs/graphql (for GraphQL schema)
 * - Manual registration in `enumNameRegistry` (for Swagger/OpenAPI)
 *
 * @example
 * ```typescript
 * export enum StatusEnum {
 *   ACTIVE = 'active',
 *   INACTIVE = 'inactive'
 * }
 *
 * // Register for both GraphQL and REST
 * registerEnum(StatusEnum, {
 *   name: 'StatusEnum',
 *   description: 'User status'
 * });
 *
 * // Register only for REST (no GraphQL)
 * registerEnum(StatusEnum, {
 *   name: 'StatusEnum',
 *   graphql: false
 * });
 *
 * // Register only for GraphQL (no REST)
 * registerEnum(StatusEnum, {
 *   name: 'StatusEnum',
 *   swagger: false
 * });
 * ```
 *
 * @param enumRef - The enum reference to register
 * @param options - Registration options
 */
export function registerEnum<T extends object = any>(enumRef: T, options: RegisterEnumOptions<T>): void {
  const { description, graphql = true, name, swagger = true, valuesMap } = options;

  if (!name) {
    throw new Error('Enum name is required for registerEnum');
  }

  // Register for Swagger/REST if enabled
  if (swagger) {
    enumNameRegistry.set(enumRef, name);
  }

  // Register for GraphQL if enabled
  if (graphql && !graphqlEnumRegistry.has(enumRef)) {
    registerEnumType(enumRef, {
      description,
      name,
      valuesMap,
    });
    graphqlEnumRegistry.add(enumRef);
  }
}

/**
 * Options for {@link registerEnums} bulk registration.
 *
 * Controls which API layers the enums are registered for (GraphQL and/or Swagger/REST).
 * When omitted, enums are registered for both layers.
 */
export interface RegisterEnumsOptions {
  /**
   * Whether to register enums for GraphQL using registerEnumType.
   * @default true
   */
  graphql?: boolean;

  /**
   * Whether to register enums in the enumNameRegistry for Swagger/REST.
   * When enabled, enum names are auto-detected by {@link UnifiedField} decorators
   * for the `enumName` property in Swagger/OpenAPI schemas.
   * @default true
   */
  swagger?: boolean;
}

/**
 * Bulk-register all enums from a barrel-export namespace object.
 *
 * Uses the **export key names** as enum names — no manual name repetition
 * needed. Call this once per project, typically in your module setup.
 *
 * @example
 * ```typescript
 * // src/server/common/enums/index.ts (barrel file)
 * export { ContactStatusEnum } from './contact-status.enum';
 * export { IndustryEnum } from './industry.enum';
 * export { NotifyViaEnum } from './notify-via.enum';
 *
 * // src/server/server.module.ts (one line)
 * import * as Enums from './common/enums';
 * registerEnums(Enums);
 *
 * // Result: ContactStatusEnum, IndustryEnum, NotifyViaEnum are all
 * // registered for both GraphQL and Swagger auto-detection.
 * ```
 *
 * Only plain objects with string/number values (enum-like objects) are
 * registered. Non-enum exports (functions, classes, strings) are skipped.
 *
 * @param namespace - The barrel-export namespace object (`import * as X from '...'`)
 * @param options - Optional: control GraphQL/Swagger registration
 */
export function registerEnums(namespace: Record<string, any>, options?: RegisterEnumsOptions): void {
  const { graphql = true, swagger = true } = options ?? {};

  for (const [name, value] of Object.entries(namespace)) {
    // Skip non-objects (functions, strings, numbers, etc.)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue;
    }

    // Skip if already registered for all requested targets
    const alreadySwagger = !swagger || enumNameRegistry.has(value);
    const alreadyGraphql = !graphql || graphqlEnumRegistry.has(value);
    if (alreadySwagger && alreadyGraphql) {
      continue;
    }

    // Verify it looks like an enum: all own values are strings or numbers
    const vals = Object.values(value);
    if (vals.length === 0 || !vals.every((v) => typeof v === 'string' || typeof v === 'number')) {
      continue;
    }

    registerEnum(value, { graphql, name, swagger });
  }
}
