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
  public static async check(
    value: any,
    user: { id: any; hasRole: (roles: string[]) => boolean },
    metatype?,
  ): Promise<any> {
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

  // Standard error function
  public static errorFunction(caller: Function) {
    const err = new Error('Required parameter is missing or invalid');
    Error.captureStackTrace(err, caller);
    throw err;
  }

  /**
   * Check if parameter is an array
   */
  public static isArray(
    parameter: any,
    falseFunction: Function = InputHelper.errorFunction,
  ): boolean {
    return parameter !== null &&
      typeof parameter !== 'undefined' &&
      parameter.constructor === Array
      ? true
      : falseFunction(InputHelper.isArray);
  }

  /**
   * Checks if it is a basic type
   */
  public static isBasicType(
    metatype: any,
    falseFunction: Function = InputHelper.returnFalse,
  ): boolean {
    const types = [String, Boolean, Number, Array, Object, Buffer, ArrayBuffer];
    return types.includes(metatype)
      ? true
      : falseFunction(InputHelper.isBasicType);
  }

  /**
   * Check if parameter is between min and max
   */
  public static isBetween(
    parameter: number,
    min: number,
    max: number,
    falseFunction: Function = InputHelper.errorFunction,
  ): boolean {
    return typeof parameter === 'number' && parameter > min && parameter < max
      ? true
      : falseFunction(InputHelper.isBetween);
  }

  /**
   * Check if parameter is a Date
   */
  public static isDate(
    parameter: Date,
    falseFunction: Function = InputHelper.errorFunction,
  ): boolean {
    return parameter instanceof Date ? true : falseFunction(InputHelper.isDate);
  }

  /**
   * Check if parameter is a valid email address
   */
  public static isEmail(
    parameter: string,
    falseFunction: Function = InputHelper.errorFunction,
  ): boolean {
    const regex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,})+$/;
    return regex.test(parameter) ? true : falseFunction(InputHelper.isEmail);
  }

  /**
   * Check whether the parameter can be converted to false
   */
  public static isFalse(
    parameter: any,
    falseFunction: Function = InputHelper.errorFunction,
  ): boolean {
    return !parameter ? true : falseFunction(InputHelper.isFalse);
  }

  /**
   * Check if parameter is a valid file
   */
  public static isFile(
    parameter: any,
    falseFunction: Function = InputHelper.errorFunction,
  ): boolean {
    return parameter !== null &&
      typeof parameter !== 'undefined' &&
      parameter.name &&
      parameter.path &&
      parameter.type &&
      parameter.size > 0
      ? true
      : falseFunction(InputHelper.isFile);
  }

  /**
   * Check if parameter is a function
   */
  public static isFunction(
    parameter: Function,
    falseFunction: Function = InputHelper.errorFunction,
  ): boolean {
    return typeof parameter === 'function'
      ? true
      : falseFunction(InputHelper.isFunction);
  }

  /**
   * Check if parameter is greater than the compare number
   */
  public static isGreater(
    parameter: number,
    compare: number,
    falseFunction: Function = InputHelper.errorFunction,
  ): boolean {
    return typeof parameter === 'number' && parameter > compare
      ? true
      : falseFunction(InputHelper.isGreater);
  }

  /**
   * Check if parameter is lower than the compare number
   */
  public static isLower(
    parameter: number,
    compare: number,
    falseFunction: Function = InputHelper.errorFunction,
  ): boolean {
    return typeof parameter === 'number' && parameter < compare
      ? true
      : falseFunction(InputHelper.isLower);
  }

  /**
   * Check if parameter is a non empty array
   */
  public static isNonEmptyArray(
    parameter: any,
    errorFunction: Function = InputHelper.errorFunction,
  ): boolean {
    return parameter !== null &&
      typeof parameter !== 'undefined' &&
      parameter.constructor === Array &&
      parameter.length > 0
      ? true
      : errorFunction(InputHelper.isNonEmptyArray);
  }

  /**
   * Check if parameter is a non empty object
   */
  public static isNonEmptyObject(
    parameter: any,
    falseFunction: Function = InputHelper.errorFunction,
  ): boolean {
    return parameter !== null &&
      typeof parameter !== 'undefined' &&
      parameter.constructor === Object &&
      Object.keys(parameter).length !== 0
      ? true
      : falseFunction(InputHelper.isNonEmptyObject);
  }

  /**
   * Check if parameter is a non empty string
   */
  public static isNonEmptyString(
    parameter: string,
    falseFunction: Function = InputHelper.errorFunction,
  ): boolean {
    return typeof parameter === 'string' && parameter.length > 0
      ? true
      : falseFunction(InputHelper.isNonEmptyString);
  }

  /**
   * Check if parameter is a number
   */
  public static isNumber(
    parameter: number,
    falseFunction: Function = InputHelper.errorFunction,
  ): boolean {
    return typeof parameter === 'number'
      ? true
      : falseFunction(InputHelper.isNumber);
  }

  /**
   * Check if parameter is an object
   */
  public static isObject(
    parameter: any,
    falseFunction: Function = InputHelper.errorFunction,
  ): boolean {
    return parameter !== null &&
      typeof parameter !== 'undefined' &&
      parameter.constructor === Object
      ? true
      : falseFunction(InputHelper.isObject);
  }

  /**
   * Check whether the parameter can be converted to true
   */
  public static isTrue(
    parameter: any,
    falseFunction: Function = InputHelper.errorFunction,
  ): boolean {
    return !!parameter ? true : falseFunction(InputHelper.isTrue);
  }

  /**
   * Check if parameter is a string
   */
  public static isString(
    parameter: string,
    falseFunction: Function = InputHelper.errorFunction,
  ): boolean {
    return typeof parameter === 'string'
      ? true
      : falseFunction(InputHelper.isString);
  }

  /**
   * Alternative for errorFunction
   */
  public static returnFalse(): boolean {
    return false;
  }

  /**
   * Map values into specific type
   */
  public static map<T>(
    values: Partial<T>,
    ctor: new () => T,
    cloneDeep = true,
  ): T {
    const instance = new ctor();

    return Object.keys(instance).reduce((obj, key) => {
      obj[key] = cloneDeep ? _.cloneDeep(values[key]) : values[key];
      return obj;
    }, instance);
  }
}
