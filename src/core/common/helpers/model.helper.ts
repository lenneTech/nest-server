import * as _ from 'lodash';

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
