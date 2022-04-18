import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as _ from 'lodash';
import { checkRestricted } from '../decorators/restricted.decorator';

/**
 * Helper class for inputs
 * @deprecated use functions directly
 */
export default class InputHelper {
  /**
   * Check input
   */
  public static async check(
    value: any,
    user: { id: any; hasRole: (roles: string[]) => boolean },
    metatype?
  ): Promise<any> {
    return check(value, user, metatype);
  }

  // Standard error function
  public static errorFunction(caller: (...params) => any, message = 'Required parameter is missing or invalid') {
    return errorFunction(caller, message);
  }

  /**
   * Check if parameter is an array
   */
  public static isArray(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
    return isArray(parameter, falseFunction);
  }

  /**
   * Checks if it is a basic type
   */
  public static isBasicType(metatype: any, falseFunction: (...params) => any = returnFalse): boolean {
    return isBasicType(metatype, falseFunction);
  }

  /**
   * Check if parameter is between min and max
   */
  public static isBetween(
    parameter: number,
    min: number,
    max: number,
    falseFunction: (...params) => any = errorFunction
  ): boolean {
    return isBetween(parameter, min, max, falseFunction);
  }

  /**
   * Check if parameter is a Date
   */
  public static isDate(parameter: Date, falseFunction: (...params) => any = errorFunction): boolean {
    return isDate(parameter, falseFunction);
  }

  /**
   * Check if parameter is a valid email address
   */
  public static isEmail(parameter: string, falseFunction: (...params) => any = errorFunction): boolean {
    return isEmail(parameter, falseFunction);
  }

  /**
   * Check whether the parameter can be converted to false
   */
  public static isFalse(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
    return isFalse(parameter, falseFunction);
  }

  /**
   * Check if parameter is a valid file
   */
  public static isFile(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
    return isFile(parameter, falseFunction);
  }

  /**
   * Check if parameter is a function
   */
  public static isFunction(parameter: (...params) => any, falseFunction: (...params) => any = errorFunction): boolean {
    return isFunction(parameter, falseFunction);
  }

  /**
   * Check if parameter is greater than the compare number
   */
  public static isGreater(
    parameter: number,
    compare: number,
    falseFunction: (...params) => any = errorFunction
  ): boolean {
    return isGreater(parameter, compare, falseFunction);
  }

  /**
   * Check if parameter is lower than the compare number
   */
  public static isLower(
    parameter: number,
    compare: number,
    falseFunction: (...params) => any = errorFunction
  ): boolean {
    return isLower(parameter, compare, falseFunction);
  }

  /**
   * Check if parameter is a non-empty array
   */
  public static isNonEmptyArray(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
    return isNonEmptyString(parameter, errorFunction);
  }

  /**
   * Check if parameter is a non empty object
   */
  public static isNonEmptyObject(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
    return isNonEmptyObject(parameter, falseFunction);
  }

  /**
   * Check if parameter is a non empty string
   */
  public static isNonEmptyString(parameter: string, falseFunction: (...params) => any = errorFunction): boolean {
    return isNonEmptyString(parameter, falseFunction);
  }

  /**
   * Check if parameter is a number
   */
  public static isNumber(parameter: number, falseFunction: (...params) => any = errorFunction): boolean {
    return isNumber(parameter, falseFunction);
  }

  /**
   * Check if parameter is an object
   */
  public static isObject(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
    return isObject(parameter, falseFunction);
  }

  /**
   * Check whether the parameter can be converted to true
   */
  public static isTrue(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
    return isTrue(parameter, falseFunction);
  }

  /**
   * Check if parameter is a string
   */
  public static isString(parameter: string, falseFunction: (...params) => any = errorFunction): boolean {
    return isString(parameter, falseFunction);
  }

  /**
   * Alternative for errorFunction
   */
  public static returnFalse(): boolean {
    return returnFalse();
  }

  /**
   * Map values into specific type
   * @deprecated use mapClass function
   */
  public static map<T>(values: Partial<T>, ctor: new () => T, cloneDeep = true): T {
    return mapClass(values, ctor);
  }
}

/**
 * Check input
 */
export async function check(
  value: any,
  user: { id: any; hasRole: (roles: string[]) => boolean },
  metatype?
): Promise<any> {
  // Return value if it is only a basic type
  if (typeof value !== 'object' || !metatype || isBasicType(metatype)) {
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
export function errorFunction(caller: (...params) => any, message = 'Required parameter is missing or invalid') {
  const err = new Error(message);
  Error.captureStackTrace(err, caller);
  throw err;
}

/**
 * Check if parameter is an array
 */
export function isArray(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
  return Array.isArray(parameter) ? true : falseFunction(isArray);
}

/**
 * Checks if it is a basic type
 */
export function isBasicType(metatype: any, falseFunction: (...params) => any = returnFalse): boolean {
  const types = [String, Boolean, Number, Array, Object, Buffer, ArrayBuffer];
  return types.includes(metatype) ? true : falseFunction(isBasicType);
}

/**
 * Check if parameter is between min and max
 */
export function isBetween(
  parameter: number,
  min: number,
  max: number,
  falseFunction: (...params) => any = errorFunction
): boolean {
  return typeof parameter === 'number' && parameter > min && parameter < max ? true : falseFunction(isBetween);
}

/**
 * Check if parameter is a Date
 */
export function isDate(parameter: Date, falseFunction: (...params) => any = errorFunction): boolean {
  return parameter instanceof Date ? true : falseFunction(isDate);
}

/**
 * Check if parameter is a valid email address
 */
export function isEmail(parameter: string, falseFunction: (...params) => any = errorFunction): boolean {
  const regex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,})+$/;
  return regex.test(parameter) ? true : falseFunction(isEmail);
}

/**
 * Check whether the parameter can be converted to false
 */
export function isFalse(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
  return !parameter ? true : falseFunction(isFalse);
}

/**
 * Check if parameter is a valid file
 */
export function isFile(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
  return parameter !== null &&
    typeof parameter !== 'undefined' &&
    parameter.name &&
    parameter.path &&
    parameter.type &&
    parameter.size > 0
    ? true
    : falseFunction(isFile);
}

/**
 * Check if parameter is a function
 */
export function isFunction(parameter: (...params) => any, falseFunction: (...params) => any = errorFunction): boolean {
  return typeof parameter === 'function' ? true : falseFunction(isFunction);
}

/**
 * Check if parameter is greater than the compare number
 */
export function isGreater(
  parameter: number,
  compare: number,
  falseFunction: (...params) => any = errorFunction
): boolean {
  return typeof parameter === 'number' && parameter > compare ? true : falseFunction(isGreater);
}

/**
 * Check if parameter is lower than the compare number
 */
export function isLower(
  parameter: number,
  compare: number,
  falseFunction: (...params) => any = errorFunction
): boolean {
  return typeof parameter === 'number' && parameter < compare ? true : falseFunction(isLower);
}

/**
 * Check if parameter is a non empty array
 */
export function isNonEmptyArray(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
  return parameter !== null &&
    typeof parameter !== 'undefined' &&
    parameter.constructor === Array &&
    parameter.length > 0
    ? true
    : falseFunction(isNonEmptyArray);
}

/**
 * Check if parameter is a non empty object
 */
export function isNonEmptyObject(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
  return parameter !== null &&
    typeof parameter !== 'undefined' &&
    parameter.constructor === Object &&
    Object.keys(parameter).length !== 0
    ? true
    : falseFunction(isNonEmptyObject);
}

/**
 * Check if parameter is a non empty string
 */
export function isNonEmptyString(parameter: string, falseFunction: (...params) => any = errorFunction): boolean {
  return typeof parameter === 'string' && parameter.length > 0 ? true : falseFunction(isNonEmptyString);
}

/**
 * Check if parameter is a number
 */
export function isNumber(parameter: number, falseFunction: (...params) => any = errorFunction): boolean {
  return typeof parameter === 'number' ? true : falseFunction(isNumber);
}

/**
 * Check if parameter is an object
 */
export function isObject(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
  return parameter !== null && typeof parameter !== 'undefined' && parameter.constructor === Object
    ? true
    : falseFunction(isObject);
}

/**
 * Check whether the parameter can be converted to true
 */
export function isTrue(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
  return !!parameter ? true : falseFunction(isTrue);
}

/**
 * Check if parameter is a string
 */
export function isString(parameter: string, falseFunction: (...params) => any = errorFunction): boolean {
  return typeof parameter === 'string' ? true : falseFunction(isString);
}

/**
 * Alternative for errorFunction
 */
export function returnFalse(): boolean {
  return false;
}

/**
 * Map values into specific type
 */
export function mapClass<T>(values: Partial<T>, ctor: new () => T, cloneDeep = true): T {
  const instance = new ctor();

  return Object.keys(instance).reduce((obj, key) => {
    obj[key] = cloneDeep ? _.cloneDeep(values[key]) : values[key];
    return obj;
  }, instance);
}

/**
 * Get type of array (via first item)
 */
export function typeofArray(arr: any[], strict = false): string {
  let type: string = undefined;
  if (!arr?.length) {
    return type;
  }
  type = typeof arr[0];
  if (strict) {
    for (const item of arr) {
      if (typeof item !== type) {
        return undefined;
      }
    }
  }
  return type;
}

/**
 * Get instance of array items (via first item)
 */
export function instanceofArray(arr: any[], strict = false): string {
  let constructor: string = undefined;
  if (!arr?.length) {
    return constructor;
  }
  try {
    constructor = arr[0].constructor;
    if (strict) {
      for (const item of arr) {
        if (item.constructor !== constructor) {
          return undefined;
        }
      }
    }
  } catch (e) {
    return undefined;
  }
  return constructor;
}
