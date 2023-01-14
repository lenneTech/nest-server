import { plainToInstance } from 'class-transformer';
import { Types } from 'mongoose';
import { clone } from './input.helper';

/**
 * Helper class for models
 * @deprecated use functions directly
 */
export class ModelHelper {
  /**
   * Remove all properties from source which are not in target
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
 */
export function prepareMap<T = Record<string, any>>(
  source: Partial<T> | Record<string, any>,
  target: T,
  options: {
    cloneDeep?: boolean;
    circles?: boolean;
    funcAllowed?: boolean;
    mapId?: boolean;
    proto?: boolean;
  } = {}
): Partial<T> | Record<string, any> {
  // Set config
  const config = {
    cloneDeep: true,
    circles: true,
    funcAllowed: false,
    mapId: false,
    proto: false,
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
      result[key] =
        source[key] !== 'function' && config.cloneDeep
          ? clone(source[key], { circles: config.circles, proto: config.proto })
          : source[key];
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
    circles?: boolean;
    funcAllowed?: boolean;
    mapId?: boolean;
    proto?: boolean;
  } = {}
): T {
  // Set config
  const config = {
    cloneDeep: true,
    circles: false,
    funcAllowed: false,
    mapId: false,
    proto: false,
    ...options,
  };

  // Check source
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return config.cloneDeep ? clone(target, { circles: config.circles, proto: config.proto }) : target;
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
 * @param [options] - Additional settings for processing
 * @returns Record with mapped objects
 */
export function mapClasses<T = Record<string, any>>(
  input: Record<string, any>,
  mapping: Record<string, new (...args: any[]) => any>,
  target?: T,
  options?: { objectIdsToString?: boolean; removeUndefinedProperties?: boolean }
): T {
  // Check params
  if (!target) {
    target = {} as T;
  }
  if (!input || !mapping) {
    return target;
  }

  // Get config
  const config = {
    objectIdsToString: true,
    removeUndefinedProperties: false,
    ...options,
  };

  // Process input
  for (const [prop, mapTarget] of Object.entries(mapping)) {
    if (prop in input) {
      const targetClass = mapTarget as any;
      const value = input[prop];

      // Do not process null (undefined is removed at the end)
      if (value === null) {
        target[prop] = null;
        continue;
      }

      // Process array
      else if (Array.isArray(value)) {
        const arr = [];
        for (const item of value) {
          if (item instanceof targetClass) {
            arr.push(item);
          } else if (item instanceof Types.ObjectId) {
            config.objectIdsToString ? arr.push(item.toHexString()) : arr.push(item);
          } else if (typeof item === 'object') {
            if (targetClass.map) {
              arr.push(targetClass.map(item));
            } else {
              arr.push(plainToInstance(targetClass, item));
            }
          } else {
            arr.push(item);
          }
        }
        target[prop] = arr as any;
      }

      // Process ObjectId
      else if (value instanceof Types.ObjectId) {
        target[prop] = config.objectIdsToString ? value.toHexString() : value;
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
      else if (!config.removeUndefinedProperties || value !== undefined) {
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
 * @param [options] - Additional settings for processing
 * @returns Record with mapped objects
 */
export async function mapClassesAsync<T = Record<string, any>>(
  input: Record<string, any>,
  mapping: Record<string, new (...args: any[]) => any>,
  target?: T,
  options?: { objectIdsToString?: boolean; removeUndefinedProperties?: boolean }
): Promise<T> {
  // Check params
  if (!target) {
    target = {} as T;
  }
  if (!input || !mapping) {
    return target;
  }

  // Get config
  const config = {
    objectIdsToString: true,
    removeUndefinedProperties: false,
    ...options,
  };

  // Process input
  for (const [prop, mapTarget] of Object.entries(mapping)) {
    if (prop in input) {
      const targetClass = mapTarget as any;
      const value = input[prop];

      // Do not process zero (undefined is removed at the end)
      if (value === null) {
        target[prop] = null;
        continue;
      }

      // Process array
      else if (Array.isArray(value)) {
        const arr = [];
        for (const item of value) {
          if (item instanceof targetClass) {
            arr.push(item);
          } else if (item instanceof Types.ObjectId) {
            config.objectIdsToString ? arr.push(item.toHexString()) : arr.push(item);
          } else if (typeof item === 'object') {
            if (targetClass.map) {
              arr.push(await targetClass.map(item));
            } else {
              arr.push(plainToInstance(targetClass, item));
            }
          } else {
            arr.push(item);
          }
        }
        target[prop] = arr as any;
      }

      // Process ObjectId
      else if (value instanceof Types.ObjectId) {
        target[prop] = config.objectIdsToString ? value.toHexString() : value;
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
      else if (!config.removeUndefinedProperties || value !== undefined) {
        target[prop] = value;
      }
    }
  }

  return target;
}

/**
 * Same as mapClasses but with option removeUndefinedProperties = true as default
 */
export function mapInputClasses<T = Record<string, any>>(
  input: Record<string, any>,
  mapping: Record<string, new (...args: any[]) => any>,
  target?: T,
  options?: { objectIdsToString?: boolean; removeUndefinedProperties?: boolean }
) {
  // Get config
  const config = {
    removeUndefinedProperties: true,
    ...options,
  };
  return mapClasses(input, mapping, target, options);
}

/**
 * Same as mapClassesAsync but with option removeUndefinedProperties = true as default
 */
export function mapInputClassesAsync<T = Record<string, any>>(
  input: Record<string, any>,
  mapping: Record<string, new (...args: any[]) => any>,
  target?: T,
  options?: { objectIdsToString?: boolean; removeUndefinedProperties?: boolean }
) {
  // Get config
  const config = {
    removeUndefinedProperties: true,
    ...options,
  };
  return mapClassesAsync(input, mapping, target, options);
}
