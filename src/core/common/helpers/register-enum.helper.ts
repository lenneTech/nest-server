import { registerEnumType } from '@nestjs/graphql';

import { enumNameRegistry } from '../decorators/unified-field.decorator';

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
  if (graphql) {
    registerEnumType(enumRef, {
      description,
      name,
      valuesMap,
    });
  }
}
