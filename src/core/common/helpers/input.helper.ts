import { BadRequestException } from '@nestjs/common';
import { plainToClass } from 'class-transformer';
import { validate } from 'class-validator';
import * as _ from 'lodash';
import { checkRestricted } from '../decorators/restricted.decorator';

/**
 * Helper class for inputs
 */
export class InputHelper {

  /**
   * Check input
   */
  public static async check(value: any, user: { id: any, hasRole: (roles: string[]) => boolean }, metatype?): Promise<any> {

    // Return value if it is only a basic type
    if (!metatype || this.isBasicType(metatype)) {
      return value;
    }

    // Remove restricted values if roles are missing
    value = checkRestricted(value, user);

    // Check values
    if (metatype) {
      const object = plainToClass(metatype, value);
      const errors = await validate(object);
      if (errors.length > 0) {
        throw new BadRequestException('Validation failed');
      }
    }
    return value;
  }

  /**
   * Checks if it is a basic type
   */
  public static isBasicType(metatype: any): boolean {
    const types = [String, Boolean, Number, Array, Object, Buffer, ArrayBuffer];
    return types.includes(metatype);
  }

  /**
   * Map values into specific type
   */
  public static map<T>(values: Partial<T>, ctor: new () => T, cloneDeep = true): T {
    const instance = new ctor();

    return Object.keys(instance).reduce((acc, key) => {
      acc[key] = cloneDeep ? _.cloneDeep(values[key]) : values[key];
      return acc;
    }, {}) as T;
  }
}
