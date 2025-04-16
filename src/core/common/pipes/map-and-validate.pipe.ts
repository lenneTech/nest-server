import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';

import { isBasicType } from '../helpers/input.helper';

@Injectable()
export class MapAndValidatePipe implements PipeTransform {
  async transform(value: any, metadata: ArgumentMetadata) {
    const { metatype } = metadata;

    if (!value || typeof value !== 'object' || !metatype || isBasicType(metatype)) {
      return value;
    }

    // Convert to metatype
    if (!(value instanceof metatype)) {
      if ((metatype as any)?.map) {
        value = (metatype as any)?.map(value);
      } else {
        value = plainToInstance(metatype, value);
      }
    }

    // Validate
    const errors = await validate(value, { forbidUnknownValues: false });
    if (errors.length > 0) {
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
      throw new BadRequestException(result);
    }

    return value;
  }
}
