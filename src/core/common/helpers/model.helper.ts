/**
 * Helper class for models
 */
import { CoreModel } from '../models/core-model.model';
import * as _ from 'lodash';

export class ModelHelper {
  /**
   * Simple map function
   */
  public static map<T = Record<string, any>>(
    source: Partial<T> | Record<string, any>,
    target: T,
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
    } = {}
  ): T {
    // Set config
    const config = {
      cloneDeep: true,
      funcAllowed: false,
      ...options,
    };

    // Check source
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return config.cloneDeep ? _.cloneDeep(target) : target;
    }

    // Update properties
    for (const key of Object.keys(target)) {
      if (source[key] !== undefined && (config.funcAllowed || typeof (source[key] !== 'function'))) {
        target[key] = source[key] !== 'function' && config.cloneDeep ? _.cloneDeep(source[key]) : source[key];
      }
    }

    // Return target
    return target;
  }

  /**
   * Create Object or Objects of specified type with specified data
   */
  public static maps<T extends CoreModel>(
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
      return (targetClass as any).map(item, { cloneDeep: true });
    });
  }
}
