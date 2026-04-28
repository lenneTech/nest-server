import { Field, FieldOptions, HideField } from '@nestjs/graphql';
import { TypeMetadataStorage } from '@nestjs/graphql/dist/schema-builder/storages/type-metadata.storage.js';
import { Prop, PropOptions } from '@nestjs/mongoose';
import { ApiHideProperty, ApiProperty, ApiPropertyOptions } from '@nestjs/swagger';
import type { EnumAllowedTypes } from '@nestjs/swagger/dist/interfaces/schema-object-metadata.interface.js';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDate,
  IsDefined,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateIf,
  ValidateNested,
  ValidationOptions,
} from 'class-validator';
import { GraphQLScalarType, isEnumType } from 'graphql';

import { RoleEnum } from '../enums/role.enum';
import { Restricted, RestrictedType } from './restricted.decorator';

// Registry to store nested type information for validation
// Key: `${className}.${propertyName}`, Value: nested type constructor
export const nestedTypeRegistry = new Map<string, any>();

/**
 * Registry to map enum objects to their names.
 * This is populated when registerEnumType is called or can be manually populated.
 */
export const enumNameRegistry = new Map<any, string>();

// Metadata keys for input whitelist tracking
export const UNIFIED_FIELD_KEYS = Symbol('UNIFIED_FIELD_KEYS');
export const EXCLUDED_FIELD_KEYS = Symbol('EXCLUDED_FIELD_KEYS');
export const FORCE_INCLUDED_FIELD_KEYS = Symbol('FORCE_INCLUDED_FIELD_KEYS');

/**
 * Get whitelisted @UnifiedField keys for a class, respecting inheritance.
 *
 * Priority model (3 levels):
 * 1. Explicit settings (exclude: true / exclude: false) — resolved by nearest class (child wins)
 * 2. Implicit includes (@UnifiedField without exclude) — overridden by any explicit exclude: true
 *
 * Rules:
 * - exclude: true → explicit exclusion, wins over implicit @UnifiedField from anywhere in chain
 * - exclude: false → explicit re-enable, can override parent's exclude: true
 * - @UnifiedField (no exclude) → implicit inclusion, CANNOT override parent's exclude: true
 * - Among explicit settings, child class wins (first encountered while walking up the chain)
 */
export function getUnifiedFieldKeys(metatype: Function): Set<string> {
  const cacheKey = Symbol.for('UNIFIED_FIELD_KEYS_RESOLVED');
  const cached = Reflect.getOwnMetadata(cacheKey, metatype);
  if (cached) return cached;

  const implicitIncludes = new Set<string>();
  const explicitExcludes = new Set<string>();
  const explicitIncludes = new Set<string>();
  const explicitlyResolved = new Set<string>();

  // Walk from child (most specific) to parent
  let current = metatype;
  while (current && current !== Object && current !== Function && current.prototype) {
    const included: string[] = Reflect.getOwnMetadata(UNIFIED_FIELD_KEYS, current.prototype) || [];
    const excluded: string[] = Reflect.getOwnMetadata(EXCLUDED_FIELD_KEYS, current.prototype) || [];
    const forceIncluded: string[] = Reflect.getOwnMetadata(FORCE_INCLUDED_FIELD_KEYS, current.prototype) || [];

    for (const key of forceIncluded) {
      if (!explicitlyResolved.has(key)) {
        explicitIncludes.add(key);
        explicitlyResolved.add(key);
      }
    }

    for (const key of excluded) {
      if (!explicitlyResolved.has(key)) {
        explicitExcludes.add(key);
        explicitlyResolved.add(key);
      }
    }

    for (const key of included) {
      implicitIncludes.add(key);
    }

    current = Object.getPrototypeOf(current);
  }

  // Build final set: start with implicit includes
  const result = new Set(implicitIncludes);

  // Add explicit includes (force re-enabled keys)
  for (const key of explicitIncludes) {
    result.add(key);
  }

  // Remove explicit excludes
  for (const key of explicitExcludes) {
    result.delete(key);
  }

  Reflect.defineMetadata(cacheKey, result, metatype);
  return result;
}

export interface UnifiedFieldOptions {
  /** Description used for both Swagger & Gql */
  description?: string;
  /**
   * Control input whitelist behavior:
   * - true: Exclude this property (reject via REST/GraphQL, no decorators applied)
   * - false: Explicitly re-enable (can override parent's exclude: true)
   * - undefined (default): Normal @UnifiedField behavior
   */
  exclude?: boolean;
  /**
   * Enum for class-validator.
   *
   * **Recommended form:**
   * ```typescript
   * @UnifiedField({ enum: MyEnum })
   * @UnifiedField({ enum: MyEnum, enumName: 'MyEnum' })
   * ```
   *
   * **Deprecated long form** (still works, emits a deprecation warning):
   * ```typescript
   * @UnifiedField({ enum: { enum: MyEnum, enumName: 'MyEnum' } })
   * ```
   * The long form will be removed in a future MINOR version. Use the shortcut
   * form with the top-level `enumName` property instead.
   *
   * Why not auto-detect from the property type? TypeScript's `emitDecoratorMetadata`
   * reflects enum types as their base primitive in `design:type` — required string
   * enums become `String`, numeric enums become `Number`. Optional enum fields
   * (`status?: MyEnum`) are reflected as `Object` because TS sees the union
   * `MyEnum | undefined`. In all cases the original enum object reference is lost
   * at compile time, so the decorator cannot recover it without an explicit
   * `enum:` option.
   */
  enum?: EnumAllowedTypes | { enum: EnumAllowedTypes; enumName?: string; options?: ValidationOptions };
  /**
   * Explicit name for the enum in Swagger/GraphQL schema.
   *
   * When set, this name is used in the generated API schema. When omitted,
   * the decorator auto-detects the name via `registerEnum()`, GraphQL metadata,
   * or the enum's runtime name.
   *
   * Set to `null` to explicitly disable auto-detection (swagger receives `undefined`).
   *
   * **Note:** In the deprecated long-form, `enum: { enum: X, enumName: null }` passes
   * `null` directly to swagger (not `undefined`). The top-level `enumName: null` normalizes
   * to `undefined` for consistency. Both forms disable auto-detection effectively.
   *
   * Takes precedence over `enumName` inside a long-form `enum: { ... }` object.
   */
  enumName?: string | null;
  /** Example value for swagger api documentation */
  example?: any;
  /** Options for graphql */
  gqlOptions?: FieldOptions;
  /** Type if Swagger & Gql types aren't compatible */
  gqlType?: GraphQLScalarType | (new (...args: any[]) => any) | Record<number | string, number | string>;
  /** If the property is Any (skips all Validation) */
  isAny?: boolean;
  /** Indicates whether the property is an array. */
  isArray?: boolean;
  /** Default: false */
  isOptional?: boolean;
  /** Whether to apply Mongoose @Prop decorator. Optional, used for database models. Default: false */
  mongoose?: boolean | PropOptions;
  /** Restricted roles */
  roles?: RestrictedType | RoleEnum | RoleEnum[];
  /** Options for swagger api documentation */
  swaggerApiOptions?: ApiPropertyOptions;
  /** Type of the field, if not specified, it will be determined automatically.
   *
   * Required if the field is an array (inferred automatically or via the array flag).
   *
   * Enums should be defined via the enum option.
   *
   * For array fields, you can use either:
   * - `type: () => ItemType` (recommended, decorator adds array wrapping automatically)
   * - `type: () => [ItemType]` (also supported, decorator extracts ItemType to avoid double-nesting)
   *
   * Supports:
   * - A factory function that returns the type: `() => MyType` or `() => [MyType]`
   * - A GraphQL scalar: `GraphQLScalarType`
   * - A class constructor: `MyClass`
   * */
  type?: (() => any) | GraphQLScalarType | (new (...args: any[]) => any) | Record<number | string, number | string>; // Enums;
  /** Condition for validation */
  validateIf?: (obj: any, val: any) => boolean;
  /** Validation options for class-validator */
  validationOptions?: ValidationOptions;
  /** Custom validators, when using this option, all built-in validators are ignored */
  validator?: (opts: ValidationOptions) => PropertyDecorator[];
}

type NormalizedEnumOptions = { enum: EnumAllowedTypes; enumName?: string; options?: ValidationOptions };

/**
 * Detect whether `value` is the long-form `{ enum: MyEnum, ... }` options
 * object. If it is not, we treat `value` itself as the enum (shortcut form).
 *
 * Discrimination strategy (three layers):
 *
 * 1. **Own `enum` key** — a plain TS keyword enum (`enum Foo { ... }`) never
 *    has a member named `enum` (reserved keyword). Const-object enums CAN,
 *    but it's rare.
 *
 * 2. **Inner value is an object** — in the long form, `value.enum` holds an
 *    enum object (typeof 'object'). A const-object enum member named `enum`
 *    with a primitive value (string / number) is ruled out here.
 *
 * 3. **Inner value looks like an enum** — all of the inner object's own
 *    values must be strings or numbers. This guards against the theoretical
 *    case where a const-object enum has `enum: { nested: true }` as a member
 *    — that inner object's values are booleans, so it fails this check and
 *    the outer object is correctly treated as the shortcut form.
 */
function isEnumOptionsObject(value: unknown): value is NormalizedEnumOptions {
  if (typeof value !== 'object' || value === null) return false;
  if (!Object.prototype.hasOwnProperty.call(value, 'enum')) return false;
  const inner = (value as Record<string, unknown>).enum;
  if (typeof inner !== 'object' || inner === null) return false;
  // A valid enum object contains only string or number values (enum members).
  // If the inner object has non-primitive values it cannot be an enum, so the
  // outer object is the enum itself (shortcut form with a member named 'enum').
  const vals = Object.values(inner as Record<string, unknown>);
  return vals.length > 0 && vals.every((v) => typeof v === 'string' || typeof v === 'number');
}

/**
 * Detect likely misconfiguration: an object with `enumName` or `options` keys
 * but no `enum` key. This pattern looks like a long-form options object where
 * the required `enum` property was forgotten. Without this guard the object
 * would be silently treated as the enum itself (shortcut form), leading to
 * incorrect validation (e.g. only accepting the string "Status" instead of
 * actual enum members).
 */
function warnIfLikelyMisconfiguredEnumOptions(value: unknown, propertyHint: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const obj = value as Record<string, unknown>;
  if (
    !Object.prototype.hasOwnProperty.call(obj, 'enum') &&
    (Object.prototype.hasOwnProperty.call(obj, 'enumName') || Object.prototype.hasOwnProperty.call(obj, 'options'))
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      `[@UnifiedField] Probable misconfiguration on "${propertyHint}": the enum option has ` +
        `"enumName" or "options" but no "enum" key. Did you mean { enum: MyEnum, enumName: ... }? ` +
        `The object will be treated as the enum itself (shortcut form), which is likely wrong.`,
    );
  }
}

export function UnifiedField(opts: UnifiedFieldOptions = {}): PropertyDecorator {
  // Normalize the shortcut form `enum: MyEnum` into the long form
  // `enum: { enum: MyEnum }` so the rest of the decorator can assume a uniform
  // object shape. Single `isEnumOptionsObject` call, result reused for both variables.
  const isLongForm = opts.enum ? isEnumOptionsObject(opts.enum) : false;
  const normalizedEnum: NormalizedEnumOptions | undefined = opts.enum
    ? isLongForm
      ? (opts.enum as NormalizedEnumOptions)
      : { enum: opts.enum as EnumAllowedTypes }
    : undefined;

  // The original long-form object (if provided) — needed to distinguish
  // `enum: { enum: MyEnum, enumName: undefined }` (explicit disable) from
  // `enum: MyEnum` (shortcut: auto-detect).
  const originalEnumOpts = isLongForm ? (opts.enum as NormalizedEnumOptions) : undefined;

  return (target: any, propertyKey: string | symbol) => {
    const key = String(propertyKey);

    // Warn if the enum option looks like a long-form object with a missing `enum` key
    if (opts.enum && !originalEnumOpts) {
      warnIfLikelyMisconfiguredEnumOptions(opts.enum, `${target.constructor?.name || '?'}.${key}`);
    }

    // Deprecation warning for long-form enum: { enum: MyEnum, ... }
    if (originalEnumOpts) {
      // eslint-disable-next-line no-console
      console.warn(
        `[@UnifiedField] Deprecated long-form enum on "${target.constructor?.name || '?'}.${key}": ` +
          `enum: { enum: ... } is deprecated. Use enum: MyEnum` +
          (originalEnumOpts.enumName ? `, enumName: '${originalEnumOpts.enumName}'` : '') +
          ` instead. The long-form will be removed in a future version.`,
      );
    }

    if (opts.exclude === true) {
      // ── EXPLICIT EXCLUSION ──
      const excludedKeys: string[] = Reflect.getOwnMetadata(EXCLUDED_FIELD_KEYS, target) || [];
      if (!excludedKeys.includes(key)) {
        Reflect.defineMetadata(EXCLUDED_FIELD_KEYS, [...excludedKeys, key], target);
      }
      HideField()(target, propertyKey);
      ApiHideProperty()(target, propertyKey);
      return;
    } else if (opts.exclude === false) {
      // ── EXPLICIT RE-ENABLE ──
      const forceKeys: string[] = Reflect.getOwnMetadata(FORCE_INCLUDED_FIELD_KEYS, target) || [];
      if (!forceKeys.includes(key)) {
        Reflect.defineMetadata(FORCE_INCLUDED_FIELD_KEYS, [...forceKeys, key], target);
      }
      // Fall through to register in UNIFIED_FIELD_KEYS AND apply normal decorators
    } else {
      // ── IMPLICIT INCLUSION ──
      // Check if any parent has exclude: true for this key
      let parentExcluded = false;
      let proto = Object.getPrototypeOf(target.constructor);
      while (proto && proto !== Object && proto !== Function && proto.prototype) {
        const excluded: string[] = Reflect.getOwnMetadata(EXCLUDED_FIELD_KEYS, proto.prototype) || [];
        if (excluded.includes(key)) {
          parentExcluded = true;
          break;
        }
        proto = Object.getPrototypeOf(proto);
      }

      if (parentExcluded) {
        // Parent has exclude: true — register for tracking but skip schema decorators
        const existingKeys: string[] = Reflect.getOwnMetadata(UNIFIED_FIELD_KEYS, target) || [];
        if (!existingKeys.includes(key)) {
          Reflect.defineMetadata(UNIFIED_FIELD_KEYS, [...existingKeys, key], target);
        }
        HideField()(target, propertyKey);
        ApiHideProperty()(target, propertyKey);
        return;
      }
    }

    // Register in implicit includes (for both exclude: false and exclude: undefined without parent exclusion)
    const existingKeys: string[] = Reflect.getOwnMetadata(UNIFIED_FIELD_KEYS, target) || [];
    if (!existingKeys.includes(key)) {
      Reflect.defineMetadata(UNIFIED_FIELD_KEYS, [...existingKeys, key], target);
    }

    const metadataType = Reflect.getMetadata('design:type', target, propertyKey);
    const userType = opts.type;
    const isArrayField = opts.isArray === true || metadataType === Array;

    // Throwing because meta type only returns the generic array, but not the type of the array items
    if (metadataType === Array && !userType) {
      throw new Error(`Array field '${String(propertyKey)}' of '${String(target)}' must have an explicit type`);
    }

    const resolvedTypeFn = (): any => {
      if (userType) {
        if (userType instanceof GraphQLScalarType) {
          // Case if it's a scalar
          return userType;
        }

        if (typeof userType === 'function' && userType.prototype && userType.prototype.constructor === userType) {
          // Case if it's a function
          return userType;
        }

        try {
          // case if its a factory
          return (userType as () => any)();
        } catch {
          return userType;
        }
      }

      return metadataType;
    };

    // Resolve the type and extract item type if user provided array syntax
    const resolvedType = resolvedTypeFn();

    // If this is an array field and the user provided type: () => [ItemType],
    // extract the ItemType to avoid double-nesting (e.g., [[ItemType]])
    // We check: isArrayField (should be array) && Array.isArray (is actually an array) && length === 1 (GraphQL array syntax)
    const baseType =
      isArrayField && Array.isArray(resolvedType) && resolvedType.length === 1
        ? resolvedType[0] // Extract item type from [ItemType]
        : resolvedType; // Use as-is

    // Prepare merged options
    const gqlOpts: FieldOptions = { ...opts.gqlOptions };
    const swaggerOpts: ApiPropertyOptions & { enumName?: string } = { ...opts.swaggerApiOptions };
    const valOpts: ValidationOptions = { ...opts.validationOptions };

    // Optionality
    if (opts.isOptional) {
      IsOptional(valOpts)(target, propertyKey);

      gqlOpts.nullable = true;

      swaggerOpts.nullable = true;
      swaggerOpts.required = false;
    } else {
      // Use IsDefined to ensure field is present, then IsNotEmpty to ensure it's not empty
      IsDefined()(target, propertyKey);
      IsNotEmpty()(target, propertyKey);

      gqlOpts.nullable = false;

      swaggerOpts.nullable = false;
      swaggerOpts.required = true;
    }

    // Set type for swagger
    if (baseType) {
      if (normalizedEnum) {
        swaggerOpts.type = () => String;
      } else {
        swaggerOpts.type = baseType;
      }
    }

    // Set description
    const defaultDesc = opts.description ?? `${String(propertyKey)} of ${target.constructor.name}`;
    gqlOpts.description = gqlOpts.description ?? defaultDesc;
    swaggerOpts.description = swaggerOpts.description ?? defaultDesc;

    // Set swagger example
    if (opts.example !== undefined) {
      swaggerOpts.example = swaggerOpts.example ?? opts.example;
    }

    // Set enum options
    if (normalizedEnum && normalizedEnum.enum) {
      swaggerOpts.enum = normalizedEnum.enum;

      // Resolve enumName with priority chain:
      // 1. Top-level opts.enumName (new recommended form) — highest priority
      //    - string → use it
      //    - null → explicitly disable auto-detection
      //    - undefined → fall through to next level
      // 2. Long-form originalEnumOpts.enumName (deprecated) — backwards compat
      //    - present (even if undefined/null) → use it (preserves old semantics)
      //    - absent → fall through
      // 3. Auto-detection via registerEnum / GraphQL metadata / runtime name
      if ('enumName' in opts && opts.enumName !== undefined) {
        // Top-level enumName: string → use, null → disable auto-detection
        swaggerOpts.enumName = opts.enumName ?? undefined;
      } else if (originalEnumOpts && 'enumName' in originalEnumOpts) {
        // Deprecated long-form enumName
        swaggerOpts.enumName = originalEnumOpts.enumName;
      } else {
        // Auto-detection
        const autoDetectedName = getEnumName(normalizedEnum.enum);
        if (autoDetectedName) {
          swaggerOpts.enumName = autoDetectedName;
        }
      }
    }

    // Array handling — must run BEFORE IsEnum so `each` is resolved
    if (isArrayField) {
      swaggerOpts.isArray = true;
      IsArray(valOpts)(target, propertyKey);
      valOpts.each = true;
    } else {
      swaggerOpts.isArray = false;
      valOpts.each = false;
    }

    // Apply IsEnum after array handling so `each` from isArray is available.
    // Merge isArray's `each` into the enum options automatically — the user
    // no longer needs to pass `options: { each: true }` redundantly.
    if (normalizedEnum && normalizedEnum.enum && !opts.isAny && !opts.validator) {
      const enumValOpts: ValidationOptions = { ...normalizedEnum.options };
      if (isArrayField && enumValOpts.each === undefined) {
        enumValOpts.each = true;
      }
      IsEnum(normalizedEnum.enum, enumValOpts)(target, propertyKey);
    }

    // Type function for gql
    // We need to keep the factory pattern (calling resolvedTypeFn inside the arrow function)
    // to support circular references. But we also need to extract array item types to avoid double-nesting.
    const gqlTypeFn = isArrayField
      ? () => {
          const resolved = normalizedEnum?.enum || opts.gqlType || resolvedTypeFn();
          // Extract item type if user provided [ItemType] syntax to avoid [[ItemType]]
          return [Array.isArray(resolved) && resolved.length === 1 ? resolved[0] : resolved];
        }
      : () => normalizedEnum?.enum || opts.gqlType || resolvedTypeFn();

    // Gql decorator
    Field(gqlTypeFn, gqlOpts)(target, propertyKey);

    // Swagger decorator
    ApiProperty(swaggerOpts)(target, propertyKey);

    // Conditional validation
    if (opts.validateIf) {
      ValidateIf(opts.validateIf)(target, propertyKey);
    }

    // Completely skip validation if its any
    if (opts.validator) {
      opts.validator(valOpts).forEach((d) => d(target, propertyKey));
    } else if (!opts.isAny && !normalizedEnum) {
      // Skip the built-in validator when an enum is set: IsEnum has already been
      // applied above and is the authoritative validator for enum values. Without this
      // guard, fields declared as `foo?: MyEnum` emit `design:type = Object` (because
      // `MyEnum | undefined` is not primitive), which maps to IsObject() here and
      // rejects perfectly valid enum string values with "foo must be an object".
      const validator = getBuiltInValidator(baseType, valOpts, isArrayField, target);
      if (validator) {
        validator(target, propertyKey);
      }
    }

    if (!opts.isAny) {
      // Special handling for Date: needs @Type transformation even though it's "primitive"
      // This allows ISO date strings to be transformed to Date objects before validation
      if (baseType === Date) {
        Type(() => Date)(target, propertyKey);
      }
      // Check if it's a primitive, if not apply transform
      else if (!isPrimitive(baseType) && !normalizedEnum && !isGraphQLScalar(baseType)) {
        Type(() => baseType)(target, propertyKey);
        ValidateNested({ each: isArrayField })(target, propertyKey);

        // Store nested type info in registry for use in MapAndValidatePipe
        const className = target.constructor.name;
        const registryKey = `${className}.${String(propertyKey)}`;
        nestedTypeRegistry.set(registryKey, baseType);
      }
    }

    // Roles
    if (opts.roles) {
      const rolesArr = Array.isArray(opts.roles) ? opts.roles : [opts.roles];
      Restricted(...rolesArr)(target, propertyKey);
    }

    // Mongoose @Prop decorator (optional)
    if (opts.mongoose) {
      const propOptions: any = typeof opts.mongoose === 'object' ? opts.mongoose : {};

      // Set type for Prop if not already defined in propOptions
      if (typeof propOptions === 'object' && !Array.isArray(propOptions) && !propOptions.type && baseType) {
        propOptions.type = baseType;
      }

      // Apply array type if needed
      if (typeof propOptions === 'object' && !Array.isArray(propOptions) && isArrayField && !propOptions.type) {
        propOptions.type = [baseType];
      }

      Prop(propOptions)(target, propertyKey);
    }
  };
}

function getBuiltInValidator(
  type: any,
  opts: ValidationOptions,
  each: boolean,
  target: any,
): ((t: any, k: string | symbol) => void) | null {
  const map = new Map<any, PropertyDecorator>([
    [Boolean, IsBoolean(opts)],
    [Date, IsDate(opts)],
    [Number, IsNumber({}, opts)],
    [Object, IsObject(opts)],
    [String, IsString(opts)],
  ]);
  const decorator = map.get(type);
  if (!decorator) {
    return null;
  }
  if (each) {
    return (_t, k) => decorator(target, k);
  }
  return decorator;
}

/**
 * Helper function to extract enum name from an enum object
 * Attempts multiple strategies to find a meaningful name
 */
function getEnumName(enumObj: any): string | undefined {
  // Check if the enum was registered in our custom registry
  if (enumNameRegistry.has(enumObj)) {
    return enumNameRegistry.get(enumObj);
  }

  // Check if it's registered in GraphQL TypeMetadataStorage (most common case with registerEnumType)
  try {
    const enumsMetadata = TypeMetadataStorage.getEnumsMetadata();
    const matchingEnum = enumsMetadata.find((metadata) => metadata.ref === enumObj);
    if (matchingEnum && matchingEnum.name) {
      return matchingEnum.name;
    }
  } catch (error) {
    // TypeMetadataStorage might not be initialized yet during bootstrap
    // This is not an error, we just continue with other strategies
  }

  // Check if it's a GraphQL enum type
  if (isEnumType(enumObj)) {
    return enumObj.name;
  }

  // Check if the enum object has a name property (some custom implementations)
  if (enumObj && typeof enumObj === 'object' && 'name' in enumObj && typeof enumObj.name === 'string') {
    return enumObj.name;
  }

  // Check if it's a constructor function with a name
  if (typeof enumObj === 'function' && enumObj.name && enumObj.name !== 'Object') {
    return enumObj.name;
  }

  // For regular TypeScript enums, try to find the global variable name
  // This is a heuristic approach - not guaranteed to work in all cases
  if (enumObj && typeof enumObj === 'object') {
    // Check constructor name (though this usually returns 'Object' for enums)
    if (enumObj.constructor && enumObj.constructor.name && enumObj.constructor.name !== 'Object') {
      return enumObj.constructor.name;
    }
  }

  return undefined;
}

function isGraphQLScalar(type: any): boolean {
  // CustomScalar check (The CustomScalar interface implements these functions below)
  return (
    (type &&
      typeof type === 'function' &&
      typeof type.prototype?.serialize === 'function' &&
      typeof type.prototype?.parseValue === 'function' &&
      typeof type.prototype?.parseLiteral === 'function') ||
    type instanceof GraphQLScalarType
  );
}

function isPrimitive(fn: any): boolean {
  return [Boolean, Date, Number, String].includes(fn);
}
