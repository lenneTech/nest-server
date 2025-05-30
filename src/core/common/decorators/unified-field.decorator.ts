import { Field, FieldOptions } from '@nestjs/graphql';
import { ApiProperty, ApiPropertyOptions } from '@nestjs/swagger';
import { EnumAllowedTypes } from '@nestjs/swagger/dist/interfaces/schema-object-metadata.interface';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDate,
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
import { GraphQLScalarType } from 'graphql';

import { RoleEnum } from '../enums/role.enum';
import { Restricted, RestrictedType } from './restricted.decorator';

export interface UnifiedFieldOptions {
  /** Description used for both Swagger & Gql */
  description?: string;
  /** Enum for class-validator */
  enum?: { enum: EnumAllowedTypes; enumName?: string; options?: ValidationOptions };
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
   * Supports:
   * - A factory function that returns the type: `() => MyType`
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

export function UnifiedField(opts: UnifiedFieldOptions = {}): PropertyDecorator {
  return (target: any, propertyKey: string | symbol) => {
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

    const baseType = resolvedTypeFn();

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
      IsNotEmpty()(target, propertyKey);

      gqlOpts.nullable = false;

      swaggerOpts.nullable = false;
      swaggerOpts.required = true;
    }

    // Set type for swagger
    if (baseType) {
      if (opts.enum) {
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
    if (opts.enum && opts.enum.enum) {
      swaggerOpts.enum = opts.enum.enum;

      if (opts.enum.enumName) {
        swaggerOpts.enumName = opts.enum.enumName;
      }

      IsEnum(opts.enum.enum, opts.enum.options)(target, propertyKey);
    }

    // Array handling
    if (isArrayField) {
      swaggerOpts.isArray = true;
      IsArray(valOpts)(target, propertyKey);
      valOpts.each = true;
    } else {
      swaggerOpts.isArray = false;
      valOpts.each = false;
    }

    // Type function for gql
    const gqlTypeFn = isArrayField
      ? () => [opts.enum?.enum || opts.gqlType || resolvedTypeFn()]
      : () => opts.enum?.enum || opts.gqlType || resolvedTypeFn();

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
      opts.validator(valOpts).forEach(d => d(target, propertyKey));
    } else if (!opts.isAny) {
      const validator = getBuiltInValidator(baseType, valOpts, isArrayField, target);
      if (validator) {
        validator(target, propertyKey);
      }
    }

    if (!opts.isAny) {
      // Check if it's a primitive, if not apply transform
      if (!isPrimitive(baseType) && !opts.enum && !isGraphQLScalar(baseType)) {
        Type(() => baseType)(target, propertyKey);
        ValidateNested({ each: isArrayField })(target, propertyKey);
      }
    }

    // Roles
    if (opts.roles) {
      const rolesArr = Array.isArray(opts.roles) ? opts.roles : [opts.roles];
      Restricted(...rolesArr)(target, propertyKey);
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
    return (t, k) => decorator(target, k);
  }
  return decorator;
}

function isGraphQLScalar(type: any): boolean {
  // CustomScalar check (The CustomScalar interface implements these functions below)
  return (
    (type
      && typeof type === 'function'
      && typeof type.prototype?.serialize === 'function'
      && typeof type.prototype?.parseValue === 'function'
      && typeof type.prototype?.parseLiteral === 'function')
    || type instanceof GraphQLScalarType
  );
}

function isPrimitive(fn: any): boolean {
  return [Boolean, Date, Number, String].includes(fn);
}
