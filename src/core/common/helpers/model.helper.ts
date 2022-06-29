import { plainToInstance } from 'class-transformer';
import * as _ from 'lodash';
import { Types } from 'mongoose';

/**
 * Helper class for models
 * @deprecated use functions directly
 */
export class ModelHelper {
  /**
   * Remove all properties from source which are not in target
   * @param source
   * @param target
   * @param options
   */
  public static prepareMap<T = Record<string, any>>(
    source: Partial<T> | Record<string, any>,
    target: T,
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      mapId?: boolean;
    } = {}
  ): Partial<T> | Record<string, any> {
    return prepareMap(source, target, options);
  }

  /**
   * Simple map function
   */
  public static map<T = Record<string, any>>(
    source: Partial<T> | Record<string, any>,
    target: T,
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      mapId?: boolean;
    } = {}
  ): T {
    return map(source, target, options);
  }

  /**
   * Create Object or Objects of specified type with specified data
   */
  public static maps<T = Record<string, any>>(
    data: Partial<T> | Partial<T>[] | Record<string, any> | Record<string, any>[],
    targetClass: new (...args: any[]) => T,
    cloneDeep = true
  ): T[] {
    return maps(data, targetClass, cloneDeep);
  }
}

/**
 * Remove all properties from source which are not in target
 * @param source
 * @param target
 * @param options
 */
export function prepareMap<T = Record<string, any>>(
  source: Partial<T> | Record<string, any>,
  target: T,
  options: {
    cloneDeep?: boolean;
    funcAllowed?: boolean;
    mapId?: boolean;
  } = {}
): Partial<T> | Record<string, any> {
  // Set config
  const config = {
    cloneDeep: true,
    funcAllowed: false,
    mapId: false,
    ...options,
  };

  // Initializations
  const result = {};

  // Update properties
  for (const key of Object.keys(target)) {
    if (
      (!['id', '_id'].includes(key) || config.mapId) &&
      source[key] !== undefined &&
      (config.funcAllowed || typeof (source[key] !== 'function'))
    ) {
      result[key] = source[key] !== 'function' && config.cloneDeep ? _.cloneDeep(source[key]) : source[key];
    } else if (key === 'id' && !config.mapId) {
      result['id'] = source[key];
    }
  }

  return result;
}

/**
 * Simple map function
 */
export function map<T = Record<string, any>>(
  source: Partial<T> | Record<string, any>,
  target: T,
  options: {
    cloneDeep?: boolean;
    funcAllowed?: boolean;
    mapId?: boolean;
  } = {}
): T {
  // Set config
  const config = {
    cloneDeep: true,
    funcAllowed: false,
    mapId: false,
    ...options,
  };

  // Check source
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return config.cloneDeep ? _.cloneDeep(target) : target;
  }

  // Prepare source
  const preparedSource = prepareMap(source, target, config);

  // Merge target with prepared source
  Object.assign(target, preparedSource);

  // Return target
  return target;
}

/**
 * Create Object or Objects of specified type with specified data
 */
export function maps<T = Record<string, any>>(
  data: Partial<T> | Partial<T>[] | Record<string, any> | Record<string, any>[],
  targetClass: new (...args: any[]) => T,
  cloneDeep = true
): T[] {
  // Check data
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  // Check array
  if (!Array.isArray(data)) {
    data = [data];
  }

  // Map
  return (data as any[]).map((item) => {
    return (targetClass as any).map(item, { cloneDeep });
  });
}

/**
 * It takes an object, a mapping of properties to classes, and returns a new object with the properties mapped to instances
 * of the classes
 * @param input - The input object to map
 * @param mapping - A mapping of property names to classes
 * @param [target] - The object to map the input to. If not provided, a new object will be created
 * @returns Record with mapped objects
 */
export function mapClasses<T = Record<string, any>>(
  input: Record<string, any>,
  mapping: Record<string, new (...args: any[]) => any>,
  target?: T
): T {
  // Check params
  if (!target) {
    target = {} as T;
  }
  if (!input || !mapping) {
    return target;
  }

  // Process input
  for (const [prop, mapTarget] of Object.entries(mapping)) {
    if (prop in input) {
      const targetClass = mapTarget as any;
      const value = input[prop];

      // Process array
      if (Array.isArray(value)) {
        const arr = [];
        for (const item of value) {
          if (value instanceof targetClass) {
            arr.push(value);
          } else if (value instanceof Types.ObjectId) {
            arr.push(value);
          } else if (typeof value === 'object') {
            if (targetClass.map) {
              arr.push(targetClass.map(item));
            } else {
              arr.push(plainToInstance(targetClass, item));
            }
          } else {
            arr.push(value);
          }
        }
        target[prop] = arr as any;
      }

      // Process ObjectId
      else if (value instanceof Types.ObjectId) {
        target[prop] = value as any;
      }

      // Process object
      else if (typeof value === 'object') {
        if (value instanceof targetClass) {
          target[prop] = value as any;
        } else {
          if (targetClass.map) {
            target[prop] = targetClass.map(value);
          } else {
            target[prop] = plainToInstance(targetClass, value) as any;
          }
        }
      }

      // Others
      else {
        target[prop] = value;
      }
    }
  }

  return target;
}

/**
 * It takes an object, a mapping of properties to classes, and returns a new object with the properties mapped to instances
 * of the classes async
 * @param input - The input object to map
 * @param mapping - A mapping of property names to classes
 * @param [target] - The object to map the input to. If not provided, a new object will be created
 * @returns Record with mapped objects
 */
export async function mapClassesAsync<T = Record<string, any>>(
  input: Record<string, any>,
  mapping: Record<string, new (...args: any[]) => any>,
  target?: T
): Promise<T> {
  // Check params
  if (!target) {
    target = {} as T;
  }
  if (!input || !mapping) {
    return target;
  }

  // Process input
  for (const [prop, mapTarget] of Object.entries(mapping)) {
    if (prop in input) {
      const targetClass = mapTarget as any;
      const value = input[prop];

      // Process array
      if (Array.isArray(value)) {
        const arr = [];
        for (const item of value) {
          if (value instanceof targetClass) {
            arr.push(value);
          } else if (value instanceof Types.ObjectId) {
            arr.push(value);
          } else if (typeof value === 'object') {
            if (targetClass.map) {
              arr.push(await targetClass.map(item));
            } else {
              arr.push(plainToInstance(targetClass, item));
            }
          } else {
            arr.push(value);
          }
        }
        target[prop] = arr as any;
      }

      // Process ObjectId
      else if (value instanceof Types.ObjectId) {
        target[prop] = value as any;
      }

      // Process object
      else if (typeof value === 'object') {
        if (value instanceof targetClass) {
          target[prop] = value as any;
        } else {
          if (targetClass.map) {
            target[prop] = await targetClass.map(value);
          } else {
            target[prop] = plainToInstance(targetClass, value) as any;
          }
        }
      }

      // Others
      else {
        target[prop] = value;
      }
    }
  }

  return target;
}
