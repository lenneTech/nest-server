import * as _ from 'lodash';

/**
 * Core Model
 */
export abstract class CoreModel {
  /**
   * Static map method
   */
  public static map<T extends CoreModel>(this: new (...args: any[]) => T, data: any, item: T = new this()): T {
    return item.map(data);
  }

  /**
   * Map method
   */
  public map<T extends CoreModel>(this: T, data: Record<string, any>, cloneDeep = true): T {
    // Check data
    if (!data || Object.keys(data).length === 0) {
      return this;
    }

    // Map data
    return Object.keys(this).reduce((obj, key) => {
      if (data.hasOwnProperty(key)) {
        obj[key] = cloneDeep ? _.cloneDeep(data[key]) : data[key];
      }
      return obj;
    }, this);
  }
}
