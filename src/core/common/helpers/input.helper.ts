import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
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
    metatype?
  ): Promise<any> {
    // Return value if it is only a basic type
    if (typeof value !== 'object' || !metatype || this.isBasicType(metatype)) {
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
    const errors = await validate(value);
    if (errors.length > 0) {
      throw new BadRequestException('Validation failed');
    }

    // Remove restricted values if roles are missing
    value = checkRestricted(value, user);
    return value;
  }

  // Standard error function
  public static errorFunction(caller: (...params) => any) {
    const err = new Error('Required parameter is missing or invalid');
    Error.captureStackTrace(err, caller);
    throw err;
  }

  /**
   * Check if parameter is an array
   */
  public static isArray(parameter: any, falseFunction: (...params) => any = InputHelper.errorFunction): boolean {
    return parameter !== null && typeof parameter !== 'undefined' && parameter.constructor === Array
      ? true
      : falseFunction(InputHelper.isArray);
  }

  /**
   * Checks if it is a basic type
   */
  public static isBasicType(metatype: any, falseFunction: (...params) => any = InputHelper.returnFalse): boolean {
    const types = [String, Boolean, Number, Array, Object, Buffer, ArrayBuffer];
    return types.includes(metatype) ? true : falseFunction(InputHelper.isBasicType);
  }

  /**
   * Check if parameter is between min and max
   */
  public static isBetween(
    parameter: number,
    min: number,
    max: number,
    falseFunction: (...params) => any = InputHelper.errorFunction
  ): boolean {
    return typeof parameter === 'number' && parameter > min && parameter < max
      ? true
      : falseFunction(InputHelper.isBetween);
  }

  /**
   * Check if parameter is a Date
   */
  public static isDate(parameter: Date, falseFunction: (...params) => any = InputHelper.errorFunction): boolean {
    return parameter instanceof Date ? true : falseFunction(InputHelper.isDate);
  }

  /**
   * Check if parameter is a valid email address
   */
  public static isEmail(parameter: string, falseFunction: (...params) => any = InputHelper.errorFunction): boolean {
    const regex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,})+$/;
    return regex.test(parameter) ? true : falseFunction(InputHelper.isEmail);
  }

  /**
   * Check whether the parameter can be converted to false
   */
  public static isFalse(parameter: any, falseFunction: (...params) => any = InputHelper.errorFunction): boolean {
    return !parameter ? true : falseFunction(InputHelper.isFalse);
  }

  /**
   * Check if parameter is a valid file
   */
  public static isFile(parameter: any, falseFunction: (...params) => any = InputHelper.errorFunction): boolean {
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
    parameter: (...params) => any,
    falseFunction: (...params) => any = InputHelper.errorFunction
  ): boolean {
    return typeof parameter === 'function' ? true : falseFunction(InputHelper.isFunction);
  }

  /**
   * Check if parameter is greater than the compare number
   */
  public static isGreater(
    parameter: number,
    compare: number,
    falseFunction: (...params) => any = InputHelper.errorFunction
  ): boolean {
    return typeof parameter === 'number' && parameter > compare ? true : falseFunction(InputHelper.isGreater);
  }

  /**
   * Check if parameter is lower than the compare number
   */
  public static isLower(
    parameter: number,
    compare: number,
    falseFunction: (...params) => any = InputHelper.errorFunction
  ): boolean {
    return typeof parameter === 'number' && parameter < compare ? true : falseFunction(InputHelper.isLower);
  }

  /**
   * Check if parameter is a non empty array
   */
  public static isNonEmptyArray(
    parameter: any,
    errorFunction: (...params) => any = InputHelper.errorFunction
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
    falseFunction: (...params) => any = InputHelper.errorFunction
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
    falseFunction: (...params) => any = InputHelper.errorFunction
  ): boolean {
    return typeof parameter === 'string' && parameter.length > 0 ? true : falseFunction(InputHelper.isNonEmptyString);
  }

  /**
   * Check if parameter is a number
   */
  public static isNumber(parameter: number, falseFunction: (...params) => any = InputHelper.errorFunction): boolean {
    return typeof parameter === 'number' ? true : falseFunction(InputHelper.isNumber);
  }

  /**
   * Check if parameter is an object
   */
  public static isObject(parameter: any, falseFunction: (...params) => any = InputHelper.errorFunction): boolean {
    return parameter !== null && typeof parameter !== 'undefined' && parameter.constructor === Object
      ? true
      : falseFunction(InputHelper.isObject);
  }

  /**
   * Check whether the parameter can be converted to true
   */
  public static isTrue(parameter: any, falseFunction: (...params) => any = InputHelper.errorFunction): boolean {
    return !!parameter ? true : falseFunction(InputHelper.isTrue);
  }

  /**
   * Check if parameter is a string
   */
  public static isString(parameter: string, falseFunction: (...params) => any = InputHelper.errorFunction): boolean {
    return typeof parameter === 'string' ? true : falseFunction(InputHelper.isString);
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
  public static map<T>(values: Partial<T>, ctor: new () => T, cloneDeep = true): T {
    const instance = new ctor();

    return Object.keys(instance).reduce((obj, key) => {
      obj[key] = cloneDeep ? _.cloneDeep(values[key]) : values[key];
      return obj;
    }, instance);
  }
}
