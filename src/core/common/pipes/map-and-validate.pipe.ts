import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
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
      throw new BadRequestException(`Input validation failed:${errors.join('; ')}`);
    }

    return value;
  }
}
