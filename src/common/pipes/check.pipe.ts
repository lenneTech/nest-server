import { PipeTransform, Injectable, ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToClass } from 'class-transformer';

@Injectable()
export class CheckPipe implements PipeTransform<any> {

  /**
   * Check input
   */
  async transform(value: any, { metatype }: ArgumentMetadata) {
    if (!metatype || this.isBasicType(metatype)) {
      return value;
    }
    const object = plainToClass(metatype, value);
    const errors = await validate(object);
    if (errors.length > 0) {
      throw new BadRequestException('Validation failed');
    }
    return value;
  }

  /**
   * Checks if it is a basic type
   */
  private isBasicType(metatype: any): boolean {
    const types = [String, Boolean, Number, Array, Object];
    return types.includes(metatype);
  }
}
