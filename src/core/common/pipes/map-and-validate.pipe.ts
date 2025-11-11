import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import {
  arrayMaxSize,
  arrayMinSize,
  getMetadataStorage,
  isArray,
  isBoolean,
  isDate,
  isDateString,
  isDefined,
  isEmail,
  isEmpty,
  isEnum,
  isInt,
  isNumber,
  isString,
  isURL,
  max,
  maxLength,
  min,
  minLength,
  ValidationError,
} from 'class-validator';
import { ValidationMetadata } from 'class-validator/types/metadata/ValidationMetadata';
import { inspect } from 'util';

import { nestedTypeRegistry } from '../decorators/unified-field.decorator';
import { isBasicType } from '../helpers/input.helper';

// Debug mode can be enabled via environment variable: DEBUG_VALIDATION=true
const DEBUG_VALIDATION = process.env.DEBUG_VALIDATION === 'true';

// Type for constructor functions
type Constructor = new (...args: any[]) => any;

/**
 * Collects all parent classes in the prototype chain
 */
function getPrototypeChain(target: any): Constructor[] {
  const chain: Constructor[] = [];
  let current = target;

  while (current && current !== Object.prototype) {
    if (typeof current === 'function') {
      chain.push(current);
      current = Object.getPrototypeOf(current);
    } else {
      current = Object.getPrototypeOf(current.constructor);
    }
  }

  return chain;
}

/**
 * Validates an object against all classes in its prototype chain
 * This ensures inherited validation decorators are also checked
 */
async function validateWithInheritance(object: any, originalPlainValue: any): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  const metadataStorage = getMetadataStorage();
  const chain = getPrototypeChain(object.constructor);

  if (DEBUG_VALIDATION) {
    console.debug(
      'Prototype chain for validation:',
      chain.map((c) => c.name),
    );
    console.debug('Original plain object had keys:', Object.keys(originalPlainValue || {}));
  }

  // Track which properties have been validated to avoid duplicates from override
  const validatedProperties = new Set<string>();

  // Validate against each class in the chain
  for (const targetClass of chain) {
    // Get all metadata for this target
    const allMetadata = metadataStorage.getTargetValidationMetadatas(targetClass, null as any, false, false);

    // Filter to only include metadata that was registered directly on this class
    // This prevents parent class @IsOptional decorators from interfering with child class @IsDefined decorators
    const targetMetadata = allMetadata.filter((m: any) => m.target === targetClass);

    if (targetMetadata && targetMetadata.length > 0) {
      if (DEBUG_VALIDATION) {
        console.debug(`Validating against ${targetClass.name} (${targetMetadata.length} constraints)`);
      }

      // Create a temporary instance of this specific class for validation
      // IMPORTANT: Only copy properties that were present in the original plain object
      // This prevents properties initialized with = undefined from being considered "defined"
      const tempInstance = Object.create(targetClass.prototype);

      // Only copy properties that existed in the original plain input
      // BUT use the transformed values from 'object' (not originalPlainValue) to preserve
      // transformations like Date conversion from @Type() decorators
      if (originalPlainValue) {
        for (const key in originalPlainValue) {
          if (Object.prototype.hasOwnProperty.call(originalPlainValue, key)) {
            // Use transformed value if available, otherwise use original
            let value = object.hasOwnProperty(key) ? object[key] : originalPlainValue[key];

            // Manual Date transformation for ISO strings
            // Check if the design:type is Date and value is a string
            const designType = Reflect.getMetadata('design:type', targetClass.prototype, key);
            if (designType === Date && typeof value === 'string') {
              try {
                const dateValue = new Date(value);
                // Only use the Date if it's valid (not 'Invalid Date')
                if (!isNaN(dateValue.getTime())) {
                  value = dateValue;
                }
              } catch (error) {
                // If Date parsing fails, keep the original value
                // Validation will catch it later
              }
            }

            tempInstance[key] = value;
          }
        }
      }

      if (DEBUG_VALIDATION) {
        console.debug(`  temp instance keys:`, Object.keys(tempInstance));
      }

      // IMPORTANT: We need to manually validate using only the filtered metadata
      // because class-validator's validate() function will see ALL metadata including parent classes
      // This would cause @IsOptional() from parent classes to interfere with @IsDefined() from child classes

      // Group metadata by property
      const propertiesByName: Map<string, ValidationMetadata[]> = new Map();
      targetMetadata.forEach((m: ValidationMetadata) => {
        if (!propertiesByName.has(m.propertyName)) {
          propertiesByName.set(m.propertyName, []);
        }
        propertiesByName.get(m.propertyName)!.push(m);
      });

      // Validate each property using class-validator functions
      const classErrors: ValidationError[] = [];
      for (const [propertyName, metadataList] of Array.from(propertiesByName.entries())) {
        // Skip if this property was already validated in a child class (override)
        if (validatedProperties.has(propertyName)) {
          if (DEBUG_VALIDATION) {
            console.debug(`  Skipping ${propertyName} - already validated in child class`);
          }
          continue;
        }

        const propertyValue = tempInstance[propertyName];

        // Check if property is optional (has @IsOptional())
        const isOptional = metadataList.some((m) => m.type === 'conditionalValidation' && m.name === 'isOptional');

        // Check if field is explicitly defined as required with @IsDefined()
        // If isDefined exists, the field is required even if a parent class has @IsOptional()
        const hasIsDefined = metadataList.some((m) => m.type === 'isDefined');

        // Check for @ValidateIf() conditional validation
        // Note: @ValidateIf() has type='conditionalValidation' with name=undefined
        // while @IsOptional() has type='conditionalValidation' with name='isOptional'
        const validateIfMetadata = metadataList.find((m) => m.type === 'conditionalValidation' && !m.name);

        // If @ValidateIf() exists, evaluate its condition
        if (validateIfMetadata && validateIfMetadata.constraints?.[0]) {
          const conditionFn = validateIfMetadata.constraints[0];
          let shouldValidate = false;

          try {
            // Call the condition function with the object and value
            shouldValidate = conditionFn(tempInstance, propertyValue);
          } catch (error) {
            if (DEBUG_VALIDATION) {
              console.debug(`  Error evaluating ValidateIf condition for ${propertyName}:`, error);
            }
            // If condition evaluation fails, skip validation
            shouldValidate = false;
          }

          // If condition returns false, skip all validation for this property
          if (!shouldValidate) {
            if (DEBUG_VALIDATION) {
              console.debug(`  Property ${propertyName} skipped by ValidateIf condition`);
            }
            continue;
          }
        }

        // If property is optional (and not overridden with isDefined) and value is undefined/null, skip all validators
        if (!hasIsDefined && isOptional && (propertyValue === undefined || propertyValue === null)) {
          if (DEBUG_VALIDATION) {
            console.debug(`  Property ${propertyName} is optional and undefined/null - skipping validation`);
          }
          continue;
        }

        const propertyError = new ValidationError();
        propertyError.property = propertyName;
        propertyError.value = propertyValue;
        propertyError.target = tempInstance;
        propertyError.constraints = {};

        // Apply each constraint for this property
        for (const metadata of metadataList) {
          const constraintType = metadata.type;
          let isValid = true;
          let errorMessage = '';

          // Check if 'each' validation should be applied (for array elements)
          const shouldValidateEach =
            Array.isArray(propertyValue) && (metadata.validationTypeOptions?.each || metadata.each);

          // Use class-validator's exported functions directly - this is the official API
          // and will automatically stay updated with class-validator
          switch (constraintType) {
            case 'arrayMaxSize':
              isValid = arrayMaxSize(propertyValue, metadata.constraints?.[0]);
              errorMessage = `${propertyName} must contain no more than ${metadata.constraints?.[0]} elements`;
              break;
            case 'arrayMinSize':
              isValid = arrayMinSize(propertyValue, metadata.constraints?.[0]);
              errorMessage = `${propertyName} must contain at least ${metadata.constraints?.[0]} elements`;
              break;
            case 'customValidation':
              // Execute custom validators using the constraint class
              if (metadata.constraintCls) {
                try {
                  const constraintInstance = new (metadata.constraintCls as any)();
                  if (typeof constraintInstance.validate === 'function') {
                    // Create validation args for error messages
                    const validationArgs = {
                      constraints: metadata.constraints || [],
                      object: tempInstance,
                      property: propertyName,
                      targetName: targetClass.name,
                      value: propertyValue,
                    };

                    // Special handling for validators with arrays when 'each' option is set
                    // The 'each' property indicates validation should be applied to each array element
                    const isArrayValue = Array.isArray(propertyValue);
                    const shouldValidateEach =
                      metadata.each === true || (metadata as any).validationOptions?.each === true;

                    if (isArrayValue && shouldValidateEach) {
                      // Validate each array element individually
                      const results: boolean[] = [];
                      for (const item of propertyValue) {
                        const itemArgs = {
                          ...validationArgs,
                          value: item,
                        };
                        const itemResult = constraintInstance.validate(item, itemArgs);
                        const itemValid = itemResult instanceof Promise ? await itemResult : itemResult;
                        results.push(itemValid);
                      }
                      isValid = results.every((r) => r === true);
                    } else {
                      // Call the validate function with the property value and validation arguments
                      const validationResult = constraintInstance.validate(propertyValue, validationArgs);

                      // Handle async validators - if it returns a Promise, await it
                      isValid = validationResult instanceof Promise ? await validationResult : validationResult;
                    }

                    // Get default message and constraint name if validation failed
                    if (!isValid) {
                      // Use metadata.name for the constraint key (e.g., "isEmail", "isString")
                      const constraintName = metadata.name || 'customValidation';

                      if (typeof constraintInstance.defaultMessage === 'function') {
                        errorMessage = constraintInstance.defaultMessage(validationArgs);
                        // Replace $property placeholder with actual property name
                        errorMessage = errorMessage.replace(/\$property/g, propertyName);
                      } else {
                        errorMessage = `${propertyName} failed custom validation`;
                      }

                      // Add to constraints with the proper name
                      propertyError.constraints[constraintName] = errorMessage;
                      // Don't let the default handler add it again
                      continue;
                    }
                  } else {
                    if (DEBUG_VALIDATION) {
                      console.debug(`  Skipping customValidation for ${propertyName} - no validate method`);
                    }
                    continue;
                  }
                } catch (error) {
                  if (DEBUG_VALIDATION) {
                    console.debug(`  Error executing customValidation for ${propertyName}:`, error);
                  }
                  // If there's an error executing the validator, skip it
                  continue;
                }
              } else {
                if (DEBUG_VALIDATION) {
                  console.debug(`  Skipping customValidation for ${propertyName} - no constraint class`);
                }
                continue;
              }
              // If validation passed, continue to next constraint
              continue;
            case 'nestedValidation':
              // Validate nested objects or arrays of nested objects
              if (DEBUG_VALIDATION) {
                console.debug(`  Nested validation for ${propertyName}`);
              }

              if (propertyValue !== undefined && propertyValue !== null) {
                const nestedErrors: ValidationError[] = [];

                // Get the target type from the nested type registry
                const registryKey = `${targetClass.name}.${propertyName}`;
                const nestedType = nestedTypeRegistry.get(registryKey);

                if (DEBUG_VALIDATION) {
                  console.debug(`[NESTED] Looking up ${registryKey}, found:`, nestedType?.name);
                }

                if (Array.isArray(propertyValue)) {
                  // Array of nested objects - validate each element
                  for (let i = 0; i < propertyValue.length; i++) {
                    const item = propertyValue[i];

                    if (item && typeof item === 'object') {
                      // Skip validation if we don't have type information
                      if (!nestedType) {
                        if (DEBUG_VALIDATION) {
                          console.debug(`[NESTED] Skipping validation for array item ${i} - no type info`);
                        }
                        continue;
                      }

                      // Transform plain object to class instance if needed
                      let transformedItem = item;
                      if (!item.constructor || item.constructor === Object) {
                        transformedItem = plainToInstance(nestedType, item, {
                          enableImplicitConversion: false,
                          excludeExtraneousValues: false,
                        });
                      }

                      if (DEBUG_VALIDATION) {
                        console.debug(`[NESTED] Validating array item ${i}:`);
                        console.debug(`[NESTED]   Original type: ${item.constructor?.name}`);
                        console.debug(`[NESTED]   Transformed type: ${transformedItem.constructor?.name}`);
                        console.debug(`[NESTED]   Target type: ${nestedType?.name}`);
                      }

                      // Skip if transformation resulted in invalid value
                      if (!transformedItem || typeof transformedItem !== 'object') {
                        if (DEBUG_VALIDATION) {
                          console.debug(`[NESTED] Skipping validation - invalid transformed item`);
                        }
                        continue;
                      }

                      // Use validateWithInheritance() for nested objects to handle override semantics
                      const itemErrors = await validateWithInheritance(transformedItem, item);

                      if (itemErrors.length > 0 && DEBUG_VALIDATION) {
                        console.debug(`[NESTED]   Errors (${itemErrors.length}):`);
                        itemErrors.forEach((err, idx) => {
                          console.debug(
                            `[NESTED]     Error ${idx}: property="${err.property}", constraints=${JSON.stringify(err.constraints)}`,
                          );
                        });
                      }

                      if (itemErrors.length > 0) {
                        // Prefix property names with array index for better error messages
                        itemErrors.forEach((err) => {
                          err.property = `${i}.${err.property}`;
                        });
                        nestedErrors.push(...itemErrors);

                        if (DEBUG_VALIDATION) {
                          console.debug(`      Found ${itemErrors.length} errors in item ${i}`);
                        }
                      }
                    }
                  }
                } else if (typeof propertyValue === 'object') {
                  // Single nested object
                  // Skip validation if we don't have type information
                  if (!nestedType) {
                    if (DEBUG_VALIDATION) {
                      console.debug(`[NESTED] Skipping validation for single object - no type info`);
                    }
                  } else {
                    // Transform plain object to class instance if needed
                    let transformedItem = propertyValue;
                    if (!propertyValue.constructor || propertyValue.constructor === Object) {
                      transformedItem = plainToInstance(nestedType, propertyValue, {
                        enableImplicitConversion: false,
                        excludeExtraneousValues: false,
                      });
                    }

                    if (DEBUG_VALIDATION) {
                      console.debug(`[NESTED] Validating single object:`);
                      console.debug(`[NESTED]   Original type: ${propertyValue.constructor?.name}`);
                      console.debug(`[NESTED]   Transformed type: ${transformedItem.constructor?.name}`);
                      console.debug(`[NESTED]   Target type: ${nestedType?.name}`);
                    }

                    // Skip if transformation resulted in invalid value
                    if (!transformedItem || typeof transformedItem !== 'object') {
                      if (DEBUG_VALIDATION) {
                        console.debug(`[NESTED] Skipping validation - invalid transformed item`);
                      }
                    } else {
                      // Use validateWithInheritance() for nested objects to handle override semantics
                      const itemErrors = await validateWithInheritance(transformedItem, propertyValue);

                      if (itemErrors.length > 0 && DEBUG_VALIDATION) {
                        console.debug(`[NESTED]   Errors (${itemErrors.length}):`, itemErrors);
                      }

                      if (itemErrors.length > 0) {
                        nestedErrors.push(...itemErrors);

                        if (DEBUG_VALIDATION) {
                          console.debug(`      Found ${itemErrors.length} errors in nested object`);
                        }
                      }
                    }
                  }
                }

                if (nestedErrors.length > 0) {
                  propertyError.children = nestedErrors;

                  if (DEBUG_VALIDATION) {
                    console.debug(`  Total nested errors for ${propertyName}: ${nestedErrors.length}`);
                  }
                }
              }

              // Nested validation doesn't add constraints, only children
              // Continue to next validator
              continue;
            case 'isArray':
              isValid = isArray(propertyValue);
              errorMessage = `${propertyName} must be an array`;
              break;
            case 'isBoolean':
              if (shouldValidateEach) {
                isValid = propertyValue.every((item) => isBoolean(item));
              } else {
                isValid = isBoolean(propertyValue);
              }
              errorMessage = `${propertyName} must be a boolean value`;
              break;
            case 'isDate':
              if (shouldValidateEach) {
                isValid = propertyValue.every((item) => isDate(item));
              } else {
                isValid = isDate(propertyValue);
              }
              errorMessage = `${propertyName} must be a Date instance`;
              break;
            case 'isDateString':
              if (shouldValidateEach) {
                isValid = propertyValue.every((item) => isDateString(item, metadata.constraints?.[0]));
              } else {
                isValid = isDateString(propertyValue, metadata.constraints?.[0]);
              }
              errorMessage = `${propertyName} must be a valid ISO 8601 date string`;
              break;
            case 'isDefined':
              isValid = isDefined(propertyValue);
              errorMessage = `${propertyName} should not be null or undefined`;
              break;
            case 'isEmail':
              if (shouldValidateEach) {
                isValid = propertyValue.every((item) => isEmail(item, metadata.constraints?.[0]));
              } else {
                isValid = isEmail(propertyValue, metadata.constraints?.[0]);
              }
              errorMessage = `${propertyName} must be an email`;
              break;
            case 'isEnum':
              if (shouldValidateEach) {
                isValid = propertyValue.every((item) => isEnum(item, metadata.constraints?.[0]));
              } else {
                isValid = isEnum(propertyValue, metadata.constraints?.[0]);
              }
              errorMessage = `${propertyName} must be a valid enum value`;
              break;
            case 'isInt':
              if (shouldValidateEach) {
                isValid = propertyValue.every((item) => isInt(item));
              } else {
                isValid = isInt(propertyValue);
              }
              errorMessage = `${propertyName} must be an integer number`;
              break;
            case 'isNotEmpty':
              if (shouldValidateEach) {
                isValid = propertyValue.every((item) => !isEmpty(item));
              } else {
                isValid = !isEmpty(propertyValue);
              }
              errorMessage = `${propertyName} should not be empty`;
              break;
            case 'isNumber':
              if (shouldValidateEach) {
                isValid = propertyValue.every((item) => isNumber(item, metadata.constraints?.[0]));
              } else {
                isValid = isNumber(propertyValue, metadata.constraints?.[0]);
              }
              errorMessage = `${propertyName} must be a number conforming to the specified constraints`;
              break;
            case 'isString':
              if (shouldValidateEach) {
                isValid = propertyValue.every((item) => isString(item));
              } else {
                isValid = isString(propertyValue);
              }
              errorMessage = `${propertyName} must be a string`;
              break;
            case 'isUrl':
              if (shouldValidateEach) {
                isValid = propertyValue.every((item) => isURL(item, metadata.constraints?.[0]));
              } else {
                isValid = isURL(propertyValue, metadata.constraints?.[0]);
              }
              errorMessage = `${propertyName} must be an URL address`;
              break;
            case 'max':
              if (shouldValidateEach) {
                isValid = propertyValue.every((item) => max(item, metadata.constraints?.[0]));
              } else {
                isValid = max(propertyValue, metadata.constraints?.[0]);
              }
              errorMessage = `${propertyName} must not be greater than ${metadata.constraints?.[0]}`;
              break;
            case 'maxLength':
              if (shouldValidateEach) {
                isValid = propertyValue.every((item) => maxLength(item, metadata.constraints?.[0]));
              } else {
                isValid = maxLength(propertyValue, metadata.constraints?.[0]);
              }
              errorMessage = `${propertyName} must be shorter than or equal to ${metadata.constraints?.[0]} characters`;
              break;
            case 'min':
              if (shouldValidateEach) {
                isValid = propertyValue.every((item) => min(item, metadata.constraints?.[0]));
              } else {
                isValid = min(propertyValue, metadata.constraints?.[0]);
              }
              errorMessage = `${propertyName} must not be less than ${metadata.constraints?.[0]}`;
              break;
            case 'minLength':
              if (shouldValidateEach) {
                isValid = propertyValue.every((item) => minLength(item, metadata.constraints?.[0]));
              } else {
                isValid = minLength(propertyValue, metadata.constraints?.[0]);
              }
              errorMessage = `${propertyName} must be longer than or equal to ${metadata.constraints?.[0]} characters`;
              break;
            default:
              // For any constraint type we haven't explicitly handled,
              // skip it rather than fail - this maintains forward compatibility
              if (DEBUG_VALIDATION) {
                console.debug(`  Skipping unknown constraint type: ${constraintType} for ${propertyName}`);
              }
              continue;
          }

          // Add constraint violation if validation failed
          if (!isValid) {
            propertyError.constraints[constraintType] = errorMessage;
          }
        }

        // Add error if there are constraints violated OR nested validation errors
        if (
          Object.keys(propertyError.constraints).length > 0 ||
          (propertyError.children && propertyError.children.length > 0)
        ) {
          classErrors.push(propertyError);
        }

        // Mark this property as validated
        validatedProperties.add(propertyName);
      }

      if (DEBUG_VALIDATION) {
        console.debug(`  Manual validation found ${classErrors.length} errors`);
        if (classErrors.length > 0) {
          classErrors.forEach((err, idx) => {
            console.debug(
              `    Error ${idx + 1}: property="${err.property}", constraints=${JSON.stringify(err.constraints)}`,
            );
          });
        }
      }

      if (classErrors.length > 0) {
        if (DEBUG_VALIDATION) {
          console.debug(`Found ${classErrors.length} errors in ${targetClass.name}`);
        }
        errors.push(...classErrors);
      }
    }
  }

  return errors;
}

@Injectable()
export class MapAndValidatePipe implements PipeTransform {
  async transform(value: any, metadata: ArgumentMetadata) {
    const { metatype } = metadata;

    if (DEBUG_VALIDATION) {
      console.debug('\n=== MapAndValidatePipe Debug ===');
      console.debug('Metadata:', {
        data: metadata.data,
        metatype: metatype?.name,
        type: metadata.type,
      });
      console.debug('Input value type:', typeof value);
      console.debug('Input value:', inspect(value, { colors: true, depth: 3 }));
    }

    if (!value || typeof value !== 'object' || !metatype || isBasicType(metatype)) {
      if (DEBUG_VALIDATION) {
        console.debug('Skipping validation - basic type or no metatype');
        console.debug('=== End Debug ===\n');
      }
      return value;
    }

    // Convert to metatype
    let originalPlainValue: any = null;
    let originalPlainKeys: string[] = [];
    const hasCustomMap = !!(metatype as any)?.map;

    if (!(value instanceof metatype)) {
      // Store original plain value before transformation
      originalPlainValue = value;
      originalPlainKeys = Object.keys(value);

      if (DEBUG_VALIDATION) {
        console.debug('Using plainToInstance to transform to:', metatype.name);
      }
      // Use plainToInstance (not Clean) to preserve all properties for validation
      // Disable implicit conversion to avoid unwanted type coercion (e.g., "123" -> 123)
      // Date transformation is handled separately in validateWithInheritance
      value = plainToInstance(metatype, value, {
        enableImplicitConversion: false,
        excludeExtraneousValues: false,
        exposeDefaultValues: false,
        exposeUnsetFields: false,
      });
      if (DEBUG_VALIDATION) {
        console.debug('Transformed value:', inspect(value, { colors: true, depth: 3 }));
        console.debug('Transformed value instance of:', value?.constructor?.name);
      }
    }

    // Validate with inheritance (checks all parent classes in the prototype chain)
    if (DEBUG_VALIDATION) {
      console.debug('Starting validation with inheritance');
    }

    const errors = await validateWithInheritance(value, originalPlainValue);

    if (errors.length > 0) {
      if (DEBUG_VALIDATION) {
        console.debug('Validation errors found:', errors.length);
        console.debug('Raw validation errors:');
        errors.forEach((err, index) => {
          console.debug(`\nError ${index + 1}:`);
          console.debug('  Property:', err.property);
          console.debug('  Value:', err.value);
          console.debug('  Constraints:', err.constraints);
          console.debug('  Children:', err.children?.length || 0);
          if (err.children && err.children.length > 0) {
            console.debug('  Children details:');
            err.children.forEach((child, childIndex) => {
              console.debug(`    Child ${childIndex + 1}:`);
              console.debug('      Property:', child.property);
              console.debug('      Value:', child.value);
              console.debug('      Constraints:', child.constraints);
              console.debug('      Has children:', (child.children?.length || 0) > 0);
            });
          }
        });
      }

      const result = {};
      const errorSummary: string[] = [];

      const processErrors = (errorList: ValidationError[], parentKey = '') => {
        errorList.forEach((e) => {
          const key = parentKey ? `${parentKey}.${e.property}` : e.property;

          if (e.children && e.children.length > 0) {
            processErrors(e.children, key);
          } else {
            result[key] = e.constraints;
            // Build error summary without exposing values
            if (e.constraints) {
              const constraintTypes = Object.keys(e.constraints).join(', ');
              errorSummary.push(`${key} (${constraintTypes})`);
            }
          }
        });
      };

      processErrors(errors);

      if (DEBUG_VALIDATION) {
        console.debug('\nProcessed validation result:');
        console.debug(inspect(result, { colors: true, depth: 5 }));
        console.debug('Result is empty:', Object.keys(result).length === 0);
        console.debug('Error summary:', errorSummary);
        console.debug('=== End Debug ===\n');
      }

      // Create meaningful error message without exposing sensitive values
      let errorMessage = 'Validation failed';
      if (errorSummary.length > 0) {
        const fieldCount = errorSummary.length;
        const fieldWord = fieldCount === 1 ? 'field' : 'fields';
        errorMessage = `Validation failed for ${fieldCount} ${fieldWord}: ${errorSummary.join('; ')}`;
      } else if (errors.length > 0) {
        // Handle case where there are validation errors but no constraints (nested errors only)
        const topLevelProperties = errors.map((e) => e.property).join(', ');
        errorMessage = `Validation failed for properties: ${topLevelProperties} (nested validation errors)`;
      }

      // Throw with message and validation errors (backward compatible structure)
      // Add message property to result object for better error messages
      throw new BadRequestException({
        message: errorMessage,
        ...result,
      });
    }

    if (DEBUG_VALIDATION) {
      console.debug('Validation successful - no errors');
    }

    // After successful validation: Apply CoreInput.map() cleanup logic
    // Remove properties that did not exist in source and have undefined value
    // This prevents overwriting existing data on update operations
    if (hasCustomMap && originalPlainKeys.length > 0) {
      for (const key in value) {
        if (
          Object.prototype.hasOwnProperty.call(value, key) &&
          !originalPlainKeys.includes(key) &&
          value[key] === undefined
        ) {
          delete value[key];
        }
      }

      if (DEBUG_VALIDATION) {
        console.debug('After CoreInput cleanup:', inspect(value, { colors: true, depth: 3 }));
      }
    }

    if (DEBUG_VALIDATION) {
      console.debug('=== End Debug ===\n');
    }

    return value;
  }
}
