import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';

import { isBasicType } from '../helpers/input.helper';

// Debug mode can be enabled via environment variable: DEBUG_VALIDATION=true
const DEBUG_VALIDATION = process.env.DEBUG_VALIDATION === 'true';

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
      console.debug('Input value:', JSON.stringify(value, null, 2));
    }

    if (!value || typeof value !== 'object' || !metatype || isBasicType(metatype)) {
      if (DEBUG_VALIDATION) {
        console.debug('Skipping validation - basic type or no metatype');
        console.debug('=== End Debug ===\n');
      }
      return value;
    }

    // Convert to metatype
    if (!(value instanceof metatype)) {
      if ((metatype as any)?.map) {
        if (DEBUG_VALIDATION) {
          console.debug('Using custom map function');
        }
        value = (metatype as any)?.map(value);
      } else {
        if (DEBUG_VALIDATION) {
          console.debug('Using plainToInstance to transform to:', metatype.name);
        }
        value = plainToInstance(metatype, value);
        if (DEBUG_VALIDATION) {
          console.debug('Transformed value:', JSON.stringify(value, null, 2));
          console.debug('Transformed value instance of:', value?.constructor?.name);
        }
      }
    }

    // Validate
    if (DEBUG_VALIDATION) {
      console.debug('Starting validation...');
    }
    const errors = await validate(value, { forbidUnknownValues: false });

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

      const processErrors = (errorList: ValidationError[], parentKey = '') => {
        errorList.forEach((e) => {
          const key = parentKey ? `${parentKey}.${e.property}` : e.property;

          if (e.children && e.children.length > 0) {
            processErrors(e.children, key);
          } else {
            result[key] = e.constraints;
          }
        });
      };

      processErrors(errors);

      if (DEBUG_VALIDATION) {
        console.debug('\nProcessed validation result:');
        console.debug(JSON.stringify(result, null, 2));
        console.debug('Result is empty:', Object.keys(result).length === 0);
        console.debug('=== End Debug ===\n');
      }

      throw new BadRequestException(result);
    }

    if (DEBUG_VALIDATION) {
      console.debug('Validation successful - no errors');
      console.debug('=== End Debug ===\n');
    }

    return value;
  }
}
