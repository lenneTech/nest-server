import * as _ from 'lodash';

/**
 * Helper class for configurations
 */
export class Config {
  /**
   * Special merge function (e.g. for configurations)
   *
   * It acts like the merge function of lodash:
   * - Source objects are merged into the destination object
   * - Source objects are applied from left to right
   * - Subsequent sources overwrite property assignments of previous sources
   *
   * except that arrays are not merged but overwrite arrays of previous sources.
   *
   * @param {any} obj destination object
   * @param {any[]} sources source objects
   * @returns {any}
   */
  public static merge(obj: Record<string, any>, ...sources: any[]): any {
    return _.mergeWith(obj, ...sources, (objValue: any, srcValue: any) => {
      if (Array.isArray(srcValue)) {
        return srcValue;
      }
    });
  }
}
