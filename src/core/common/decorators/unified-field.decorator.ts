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

import { RoleEnum } from '../enums/role.enum';
import { Restricted } from './restricted.decorator';

class EmailType {}

class PhoneNumberType {}
class URLType {}
export class UnifiedFieldOptions {
  /** General desc. */
  description?: string;
  /** Gql options */
  gqlOptions?: FieldOptions = undefined;
  /** If the property is optional */
  isOptional?: boolean;
  /** Role access */
  roles?: RoleEnum | RoleEnum[];
  /** Swagger options */
  swaggerApiOptions?: ApiPropertyOptions = {};
  /** If the property is an Array */
  array?: boolean = false;
  /** Validation config */
  validationOptions?: ValidationOptions = undefined;
  /** Enum validation */
  enum?: { enum: object; options?: ValidationOptions };
  /** Validator function if the built-ins don't cover the use case */
  validator?: (opts: ValidationOptions) => PropertyDecorator[];
  /** Example value for doc purposes */
  example?: any;
  /** Condition for when the property should be validated */
  validateIf?: (object: any, value: any) => boolean;
  /** Manual type if the auto-inferred type does not fit */
  type?: new (...args: any[]) => any;
}

/** All-In-One Decorator for Swagger, class-validator, gql */
export function UnifiedField(options?: UnifiedFieldOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const mergedOptions = { ...options };
    let type = Reflect.getMetadata('design:type', target, propertyKey);

    if (!isValidConstructor(type)) {
      throw new Error(
        `Invalid type provided for property '${String(propertyKey)}'. The type function must return a valid class constructor.`,
      );
    }

    mergedOptions.gqlOptions = mergedOptions.gqlOptions || {};
    mergedOptions.swaggerApiOptions = mergedOptions.swaggerApiOptions || {};
    mergedOptions.validationOptions = mergedOptions.validationOptions || {};

    if (type.name === 'Array') {
      if (!mergedOptions.type) {
        throw new Error(
          `Missing 'type' for array field '${String(propertyKey)}'. Please provide a type function via 'type: () => YourType'.`,
        );
      }
      mergedOptions.array = true;
      type = mergedOptions.type;
    }

    // Merge optional properties
    if (mergedOptions.isOptional) {
      mergedOptions.gqlOptions = {
        ...mergedOptions.gqlOptions,
        nullable: mergedOptions.gqlOptions?.nullable ?? mergedOptions.isOptional,
      };

      mergedOptions.swaggerApiOptions = {
        ...mergedOptions.swaggerApiOptions,
        nullable: mergedOptions.swaggerApiOptions?.nullable ?? mergedOptions.isOptional,
      };
    }

    // Merge examples
    if (mergedOptions.example !== undefined) {
      mergedOptions.swaggerApiOptions = {
        ...mergedOptions.swaggerApiOptions,
        example: mergedOptions.swaggerApiOptions?.example ?? mergedOptions.example,
      };
    }

    if (mergedOptions.array) {
      mergedOptions.swaggerApiOptions = {
        ...mergedOptions.swaggerApiOptions,
        type: mergedOptions.array ? [type] : type,
      };
    }

    // Set default description
    if (!mergedOptions.description) {
      const className = target.constructor.name;
      mergedOptions.description = `${String(propertyKey)} of ${className}`;
    }

    // Merge descriptions
    if (mergedOptions.description) {
      mergedOptions.gqlOptions = {
        ...mergedOptions.gqlOptions,
        description: mergedOptions.gqlOptions?.description ?? mergedOptions.description,
      };

      mergedOptions.swaggerApiOptions = {
        ...mergedOptions.swaggerApiOptions,
        description: mergedOptions.swaggerApiOptions?.description ?? mergedOptions.description,
      };
    }

    if (mergedOptions.array) {
      IsArray()(target, propertyKey);
      mergedOptions.swaggerApiOptions.isArray = true;
      mergedOptions.swaggerApiOptions.type = mergedOptions.array ? [type] : type;
      mergedOptions.validationOptions.each = true;
    }

    // GraphQL decorator
    const gqlType = () => (mergedOptions.array ? [type] : type);
    Field(gqlType, mergedOptions.gqlOptions)(target, propertyKey);

    // Swagger decorator
    if (mergedOptions.isOptional) {
      ApiPropertyOptional(mergedOptions.swaggerApiOptions)(target, propertyKey);
    } else {
      ApiProperty(mergedOptions.swaggerApiOptions)(target, propertyKey);
    }

    // class-transformer decorator
    if (!mergedOptions.validator) {
      const validator = getClassValidator(type, mergedOptions.validationOptions);
      if (validator) {
        validator(target, propertyKey); // Applying Validator from getClassValidator
      }

      if (
        // prettier-ignore
        typeof type === 'function'
        && type.prototype
        && type !== String
        && type !== Number
        && type !== Boolean
        && type !== Date
      ) {
        Type(() => type)(target, propertyKey);

        if (mergedOptions.array) {
          ValidateNested({ each: true })(target, propertyKey);
        } else {
          ValidateNested()(target, propertyKey);
        }
      }
    }

    if (mergedOptions.validator) {
      const validators = mergedOptions.validator(mergedOptions.validationOptions);
      // prettier-ignore
      validators.forEach(validator => validator(target, propertyKey));
    }

    // Only validate if the return value from validateIf is true
    if (mergedOptions.validateIf) {
      ValidateIf(mergedOptions.validateIf)(target, propertyKey);
    }

    // validation decorators
    if (mergedOptions.isOptional) {
      IsOptional()(target, propertyKey);
    } else {
      IsNotEmpty()(target, propertyKey);
    }

    // enum validation
    if (mergedOptions.enum && typeof mergedOptions.enum.enum === 'object') {
      IsEnum(mergedOptions.enum.enum, mergedOptions.enum.options)(target, propertyKey);
    }

    if (mergedOptions.roles) {
      Restricted(mergedOptions.roles)(target, propertyKey);
    }
  };
}

function getClassValidator(type: new (...args: any[]) => any, opts: ValidationOptions) {
  const resolvedType = type;

  const typeValidatorMap = new Map<new (...args: any[]) => any, () => PropertyDecorator>([
    /* eslint-disable perfectionist/sort-maps */
    // Primitive types
    [String, () => IsString(opts)],
    [Number, () => IsNumber({}, opts)],
    [Boolean, () => IsBoolean(opts)],
    [Date, () => IsDate(opts)],
    [Object, () => IsObject(opts)],

    // Custom types for more specific validations
    [EmailType, () => IsEmail({}, opts)],
    [PhoneNumberType, () => IsPhoneNumber(null, opts)],
    [URLType, () => IsUrl({}, opts)],
    /* eslint-enable perfectionist/sort-maps */
  ]);

  const validatorFactory = typeValidatorMap.get(resolvedType);
  return validatorFactory?.();
}

function isValidConstructor(value: any): boolean {
  return (
    // prettier-ignore
    typeof value === 'function'
    && (value === String
      || value === Number
      || value === Boolean
      || value === Date
      || value === Object
      || value === Array
      || value.prototype !== undefined)
  );
}
