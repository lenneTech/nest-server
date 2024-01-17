import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ValidatorOptions } from 'class-validator/types/validation/ValidatorOptions';
import { Kind } from 'graphql/index';
import * as inspector from 'inspector';
import * as util from 'util';

import { checkRestricted } from '../decorators/restricted.decorator';
import { ProcessType } from '../enums/process-type.enum';
import { RoleEnum } from '../enums/role.enum';
import { merge } from './config.helper';
import { equalIds } from './db.helper';

import _ = require('lodash');
import rfdc = require('rfdc');

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
    user: { hasRole: (roles: string[]) => boolean; id: any },
    options?: {
      dbObject?: any;
      metatype?: any;
      processType?: ProcessType;
      roles?: string | string[];
      throwError?: boolean;
    },
  ): Promise<any> {
    return check(value, user, options);
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
    falseFunction: (...params) => any = errorFunction,
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
    falseFunction: (...params) => any = errorFunction,
  ): boolean {
    return isGreater(parameter, compare, falseFunction);
  }

  /**
   * Check if parameter is lower than the compare number
   */
  public static isLower(
    parameter: number,
    compare: number,
    falseFunction: (...params) => any = errorFunction,
  ): boolean {
    return isLower(parameter, compare, falseFunction);
  }

  /**
   * Check if parameter is a non-empty array
   */
  public static isNonEmptyArray(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
    return isNonEmptyString(parameter, falseFunction);
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
    return mapClass(values, ctor, { cloneDeep });
  }
}

/**
 * Assign plain objects to the target object and ignores undefined
 */
export function assignPlain(target: Record<any, any>, ...args: Record<any, any>[]): any {
  return Object.assign(
    target,
    ...args.map(
      // Prepare records
      item =>
        // Return item if not an object or cloned record with undefined properties removed
        !item ? item : filterProperties(clone(item, { circles: false }), prop => prop !== undefined),
    ),
  );
}

/**
 * Check input
 */
export async function check(
  value: any,
  user: { hasRole: (roles: string[]) => boolean; id: any },
  options?: {
    dbObject?: any;
    metatype?: any;
    processType?: ProcessType;
    roles?: string | string[];
    throwError?: boolean;
    validatorOptions?: ValidatorOptions;
  },
): Promise<any> {
  const config = {
    throwError: true,
    ...options,
    validatorOptions: {
      forbidUnknownValues: false,
      skipUndefinedProperties: true,
      ...options?.validatorOptions,
    },
  };

  // Check roles
  if (config.roles?.length && config.throwError) {
    let roles = config.roles;
    if (!Array.isArray(roles)) {
      roles = [roles];
    }
    let valid = false;

    // Prevent access for everyone, including administrators
    if (roles.includes(RoleEnum.S_NO_ONE)) {
      throw new UnauthorizedException('No access');
    }

    // Check access
    if (
      // check if any user, including users who are not logged in, can access
      roles.includes(RoleEnum.S_EVERYONE)
      // check if user is logged in
      || (roles.includes(RoleEnum.S_USER) && user?.id)
      // check if the user has at least one of the required roles
      || user?.hasRole?.(roles)
      // check if the user is herself / himself
      || (roles.includes(RoleEnum.S_SELF) && equalIds(config.dbObject, user))
      // check if the user is the creator
      || (roles.includes(RoleEnum.S_CREATOR) && equalIds(config.dbObject?.createdBy, user))
    ) {
      valid = true;
    }
    if (!valid) {
      throw new UnauthorizedException('Missing rights');
    }
  }

  // Return value if it is only a basic type
  if (!value || typeof value !== 'object') {
    return value;
  }

  // Check array
  if (Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) {
      value[key] = await check(item, user, config);
    }
    return value;
  }

  const metatype = config.metatype;
  if (metatype) {
    // Check metatype
    if (isBasicType(metatype)) {
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
  }

  // Validate
  const errors = await validate(value, config.validatorOptions);
  if (errors.length > 0 && config.throwError) {
    throw new BadRequestException('Validation failed');
  }

  // Remove restricted values if roles are missing
  value = checkRestricted(value, user, config);
  return value;
}

/**
 * Check if input is a valid Date format and return a new Date
 */
export function checkAndGetDate(input: any): Date {
  // Create date from value
  const date = new Date(input);

  // Check value
  if (date.toString() === 'Invalid Date') {
    throw new Error('Invalid value for date');
  }

  // Check if range is valid
  date.toISOString();

  // Return date if everything is fine
  return date;
}

/**
 * Clone object
 * @param object Any object
 * @param options Finetuning of rfdc cloning
 * @param options.checkResult Whether to compare object and cloned object via JSON.stringify and try alternative cloning
 *                            methods if they are not equal
 * @param options.circles Keeping track of circular references will slow down performance with an additional 25% overhead.
 *                        Even if an object doesn't have any circular references, the tracking overhead is the cost.
 *                        By default if an object with a circular reference is passed to rfdc, it will throw
 *                        (similar to how JSON.stringify would throw). Use the circles option to detect and preserve
 *                        circular references in the object. If performance is important, try removing the circular
 *                        reference from the object (set to undefined) and then add it back manually after cloning
 *                        instead of using this option.
 * @param options.debug Whether to shoe console.debug messages
 * @param options.proto Copy prototype properties as well as own properties into the new object.
 *                      It's marginally faster to allow enumerable properties on the prototype to be copied into the
 *                      cloned object (not onto it's prototype, directly onto the object).
 */
export function clone(object: any, options?: { checkResult?: boolean; circles?: boolean; proto?: boolean }) {
  const config = {
    checkResult: true,
    circles: true,
    debug: inspector.url() !== undefined,
    proto: false,
    ...options,
  };

  try {
    const cloned = rfdc(config)(object);
    if (config.checkResult && !util.isDeepStrictEqual(object, cloned)) {
      throw new Error('Cloned object differs from original object');
    }
    return cloned;
  } catch (e) {
    if (!config.circles) {
      if (config.debug) {
        console.debug(e, config, object, 'automatic try to use rfdc with circles');
      }
      try {
        const clonedWithCircles = rfdc({ ...config, ...{ circles: true } })(object);
        if (config.checkResult && !util.isDeepStrictEqual(object, clonedWithCircles)) {
          throw new Error('Cloned object differs from original object');
        }
        return clonedWithCircles;
      } catch (e) {
        if (config.debug) {
          console.debug(e, 'rfcd with circles did not work => automatic use of _.clone!');
        }
        return _.cloneDeep(object);
      }
    } else {
      if (config.debug) {
        console.debug(e, config, object, 'automatic try to use _.clone instead rfdc');
      }
      return _.cloneDeep(object);
    }
  }
}

/**
 * Combines objects to a new single plain object and ignores undefined
 */
export function combinePlain(...args: Record<any, any>[]): any {
  return assignPlain({}, ...args);
}

/**
 * Get deep frozen object
 */
export function deepFreeze(object: any) {
  if (!object || typeof object !== 'object') {
    return object;
  }
  for (const [key, value] of Object.entries(object)) {
    object[key] = deepFreeze(value);
  }
  return Object.freeze(object);
}

/**
 * Standard error function
 */
export function errorFunction(caller: (...params) => any, message = 'Required parameter is missing or invalid') {
  const err = new BadRequestException(message);
  Error.captureStackTrace(err, caller);
  throw err;
}

/**
 * Filter function for objects
 */
export function filterProperties<T = Record<string, any>>(
  obj: T,
  filterFunction: (value?: any, key?: string, obj?: T) => boolean,
): Partial<T> {
  return Object.keys(obj)
    .filter(key => filterFunction(obj[key], key, obj))
    .reduce((res, key) => Object.assign(res, { [key]: obj[key] }), {});
}

export function getDateFromGraphQL(input: any): Date {
  // Check value
  if (input.value === undefined || input.value === null) {
    return input.value;
  }

  // Check nullable
  if (!input.value) {
    throw new Error('Invalid value for date');
  }

  // Check value type
  if (input.kind !== Kind.INT && input.kind !== Kind.STRING) {
    throw new Error('Invalid value type for date');
  }

  // Check format if value is a string
  if (input.kind === Kind.STRING && isNaN(Date.parse(input.value))) {
    throw new Error('Invalid ISO 8601 format for date');
  }

  return checkAndGetDate(input.value);
}

/**
 * Get plain copy of object
 */
export function getPlain(object: any) {
  return JSON.parse(JSON.stringify(object));
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
  falseFunction: (...params) => any = errorFunction,
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
  return parameter !== null
    && typeof parameter !== 'undefined'
    && parameter.name
    && parameter.path
    && parameter.type
    && parameter.size > 0
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
  falseFunction: (...params) => any = errorFunction,
): boolean {
  return typeof parameter === 'number' && parameter > compare ? true : falseFunction(isGreater);
}

/**
 * Check if parameter is lower than the compare number
 */
export function isLower(
  parameter: number,
  compare: number,
  falseFunction: (...params) => any = errorFunction,
): boolean {
  return typeof parameter === 'number' && parameter < compare ? true : falseFunction(isLower);
}

/**
 * Check if parameter is a non empty array
 */
export function isNonEmptyArray(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
  return parameter !== null
    && typeof parameter !== 'undefined'
    && parameter.constructor === Array
    && parameter.length > 0
    ? true
    : falseFunction(isNonEmptyArray);
}

/**
 * Check if parameter is a non empty object
 */
export function isNonEmptyObject(parameter: any, falseFunction: (...params) => any = errorFunction): boolean {
  return parameter !== null
    && typeof parameter !== 'undefined'
    && parameter.constructor === Object
    && Object.keys(parameter).length !== 0
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
 * Merge plain objects deep into target object and ignores undefined
 */
export function mergePlain(target: Record<any, any>, ...args: Record<any, any>[]): any {
  return merge(
    target,
    ...args.map(
      // Prepare records
      item =>
        // Return item if not an object or cloned record with undefined properties removed
        !item ? item : filterProperties(clone(item, { circles: false }), prop => prop !== undefined),
    ),
  );
}

/**
 * Alternative for errorFunction
 */
export function returnFalse(): boolean {
  return false;
}

/**
 * Match function to use instead of switch case
 * Inspired by https://yusfuu.medium.com/dont-use-switch-or-if-else-in-javascript-instead-try-this-82f32616c269
 *
 * Example:
 * const matched = match(expr, {
 *   Oranges: 'Oranges are $0.59 a pound.',
 *   Mangoes: 'Mangoes and papayas are $2.79 a pound.',
 *   Papayas: 'Mangoes and papayas are $2.79 a pound.',
 *   default: `Sorry, we are out of ${expr}.`,
 * });
 */
export function match(expression: any, cases: Record<any, any>): any {
  return cases[expression] || cases?.default;
}

/**
 * Map values into specific type
 */
export function mapClass<T>(
  values: Partial<T>,
  ctor: new () => T,
  options?: {
    circle?: boolean;
    cloneDeep?: boolean;
    proto?: boolean;
  },
): T {
  const config = {
    circles: false,
    cloneDeep: true,
    proto: false,
    ...options,
  };
  const instance = new ctor();

  return Object.keys(instance).reduce((obj, key) => {
    obj[key] = config.cloneDeep ? clone(values[key], { circles: config.circles, proto: config.proto }) : values[key];
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

/**
 * Process data via function deep
 */
export function processDeep(
  data: any,
  func: (data: any) => any,
  options?: {
    // Remember already processed objects to avoid infinite processes
    processedObjects?: WeakMap<new () => any, boolean>;

    // For objects of special classes or objects with special functions or special properties,
    // only the objects themselves are processed with func, not the individual properties of the object additionally
    specialClasses?: ((new (args: any[]) => any) | string)[];
    specialFunctions?: string[];
    specialProperties?: string[];
  },
): any {
  // Set options
  const { processedObjects, specialClasses, specialFunctions, specialProperties } = {
    processedObjects: new WeakMap(),
    specialClasses: [],
    specialFunctions: [],
    specialProperties: [],
    ...options,
  };

  // Check for falsifiable values
  if (!data) {
    return func(data);

    // Prevent circular processing
  } else if (typeof data === 'object') {
    if (processedObjects.get(data)) {
      return data;
    }
    processedObjects.set(data, true);
  }

  // Process array
  if (Array.isArray(data)) {
    return func(data.map(item => processDeep(item, func, { processedObjects, specialClasses })));
  }

  // Process object
  if (typeof data === 'object') {
    if (
      specialFunctions.find(sF => typeof data[sF] === 'function')
      || specialProperties.find(sP => Object.getOwnPropertyNames(data).includes(sP))
    ) {
      return func(data);
    }
    for (const specialClass of specialClasses) {
      if (
        (typeof specialClass === 'string' && specialClass === data.constructor?.name)
        || (typeof specialClass !== 'string' && data instanceof specialClass)
      ) {
        return func(data);
      }
    }
    for (const [key, value] of Object.entries(data)) {
      data[key] = processDeep(value, func, { processedObjects, specialClasses });
    }
    return func(data);
  }

  // Process others
  return func(data);
}

/**
 * Helper to avoid very slow merge of serviceOptions
 */
export function prepareServiceOptionsForCreate(serviceOptions: any) {
  if (!serviceOptions) {
    serviceOptions = {};
  }
  if (!serviceOptions.prepareInput) {
    serviceOptions.prepareInput = {};
  }
  if (serviceOptions.prepareInput.create === undefined) {
    serviceOptions.prepareInput.create;
  }
  return serviceOptions;
}

/**
 * Remove properties deep
 */
export function removePropertiesDeep(
  data: any,
  properties: string[],
  options?: {
    processedObjects?: WeakMap<new () => any, boolean>;
  },
): any {
  // Set options
  const { processedObjects } = {
    processedObjects: new WeakMap(),
    ...options,
  };

  // Check for falsifiable values
  if (!data) {
    return data;

    // Prevent circular processing
  } else if (typeof data === 'object') {
    if (processedObjects.get(data)) {
      return data;
    }
    processedObjects.set(data, true);
  }

  // Process array
  if (Array.isArray(data)) {
    return data.map(item => removePropertiesDeep(item, properties, { processedObjects }));
  }

  // Process object
  if (typeof data === 'object') {
    for (const prop of properties) {
      delete data[prop];
    }
    for (const [key, value] of Object.entries(data)) {
      data[key] = removePropertiesDeep(value, properties, { processedObjects });
    }
    return data;
  }

  // Process others
  return data;
}
