import { BadRequestException } from '@nestjs/common';
import { plainToClass } from 'class-transformer';
import { validate } from 'class-validator';
import { checkRestricted } from '../decorators/restricted.decorator';
import { Context } from './context.helper';

/**
 * Helper class for inputs
 */
export class InputHelper {

  /**
   * Check input
   */
  public async check(value, metatype, context): Promise<any> {
    // Return value if it is only a basic type
    if (!metatype || this.isBasicType(metatype)) {
      return value;
    }

    // Remove restricted values if roles are missing
    const { currentUser }: any = Context.getData(context);
    value = checkRestricted(value, currentUser);

    // Check values
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
  public isBasicType(metatype: any): boolean {
    const types = [String, Boolean, Number, Array, Object];
    return types.includes(metatype);
  }
}
