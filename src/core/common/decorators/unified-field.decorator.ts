import { Field, FieldOptions } from '@nestjs/graphql';
import { ApiProperty, ApiPropertyOptional, ApiPropertyOptions } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDate,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsPhoneNumber,
  IsString,
  IsUrl,
  ValidateIf,
  ValidateNested,
  ValidationOptions,
} from 'class-validator';
import 'reflect-metadata';
import { GraphQLScalarType } from 'graphql';

import { RoleEnum } from '../enums/role.enum';
import { Restricted, RestrictedType } from './restricted.decorator';

export interface UnifiedFieldOptions {
  array?: boolean;
  description?: string;
  enum?: { enum: object; options?: ValidationOptions };
  example?: any;
  gqlOptions?: FieldOptions;
  isOptional?: boolean;
  roles?: RestrictedType | RoleEnum | RoleEnum[];
  swaggerApiOptions?: ApiPropertyOptions;
  type?:
    | (() => any)
    | GraphQLScalarType
    | (new (...args: any[]) => any)
    | Record<number | string, number | string>; // Enums;
  validateIf?: (obj: any, val: any) => boolean;
  validationOptions?: ValidationOptions;
  validator?: (opts: ValidationOptions) => PropertyDecorator[];
}
// Marker classes for specialized validators
class EmailType {}
class PhoneNumberType {}

class URLType {}

export function UnifiedField(opts: UnifiedFieldOptions = {}): PropertyDecorator {
  return (target: any, propertyKey: string | symbol) => {
    const metadataType = Reflect.getMetadata('design:type', target, propertyKey);
    const userType = opts.type;
    const isArrayField = opts.array === true || metadataType === Array;

    const resolvedTypeFn = (): any => {
      if (userType) {
        if (userType instanceof GraphQLScalarType) { // Case if it's a scalar
          return userType;
        }
        if (
          typeof userType === 'function'
          && userType.prototype
          && userType.prototype.constructor === userType
        ) { // Case if it's a function
          return userType;
        }
        try { // case if its a factory
          return (userType as () => any)();
        } catch {
          return userType;
        }
      }
      return metadataType;
    };

    // Prepare merged options
    const gqlOpts: FieldOptions = { ...opts.gqlOptions };
    const swaggerOpts: ApiPropertyOptions = { ...opts.swaggerApiOptions };
    const valOpts: ValidationOptions = { ...opts.validationOptions };

    // Optionality
    if (opts.isOptional) {
      gqlOpts.nullable = gqlOpts.nullable ?? true;
      swaggerOpts.nullable = swaggerOpts.nullable ?? true;
    }

    // Description
    const defaultDesc = opts.description ?? `${String(propertyKey)} of ${target.constructor.name}`;
    gqlOpts.description = gqlOpts.description ?? defaultDesc;
    swaggerOpts.description = swaggerOpts.description ?? defaultDesc;

    // Swagger example
    if (opts.example !== undefined) {
      swaggerOpts.example = swaggerOpts.example ?? opts.example;
    }

    // Array handling
    if (isArrayField) {
      swaggerOpts.isArray = true;
      swaggerOpts.type = () => [resolvedTypeFn()];
      IsArray(valOpts)(target, propertyKey);
      valOpts.each = true;
    } else {
      swaggerOpts.type = resolvedTypeFn();
    }
    // Type function for gql
    const gqlTypeFn = () =>
      isArrayField
        ? [resolvedTypeFn()]
        : resolvedTypeFn();

    // Gql decorator
    Field(gqlTypeFn, gqlOpts)(target, propertyKey);

    // Swagger decorator
    const ApiDec = opts.isOptional ? ApiPropertyOptional : ApiProperty;
    ApiDec(swaggerOpts)(target, propertyKey);

    // Conditional validation
    if (opts.validateIf) {
      ValidateIf(opts.validateIf)(target, propertyKey);
    }

    // isOptional validation
    if (opts.isOptional) {
      IsOptional()(target, propertyKey);
    } else {
      IsNotEmpty()(target, propertyKey);
    }

    // Custom or builtin validator
    if (opts.validator) {
      opts.validator(valOpts).forEach(d => d(target, propertyKey));
    } else {
      const baseType = resolvedTypeFn();
      const validator = getBuiltInValidator(baseType, valOpts, isArrayField, target);
      if (validator) {
        validator(target, propertyKey);
      }
    }

    // Enum validation
    if (opts.enum) {
      IsEnum(opts.enum.enum, opts.enum.options)(target, propertyKey);
    }

    // Check if it's a primitive, if not apply transform
    const baseType = resolvedTypeFn();
    if (!isPrimitive(baseType) && baseType !== Date) {
      Type(() => baseType)(target, propertyKey);
      if (isArrayField) {
        ValidateNested({ each: true })(target, propertyKey);
      } else {
        ValidateNested()(target, propertyKey);
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
    [EmailType, IsEmail({}, opts)],
    [Number, IsNumber({}, opts)],
    [Object, IsObject(opts)],
    [PhoneNumberType, IsPhoneNumber(null, opts)],
    [String, IsString(opts)],
    [URLType, IsUrl({}, opts)],
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

function isPrimitive(fn: any): boolean {
  return [Boolean, Date, Number, String].includes(fn);
}
