import { ModelHelper } from '../helpers/model.helper';

/**
 * Core Model
 */
export abstract class CoreModel {
  /**
   * Static map method
   */
  public static map<T extends CoreModel>(
    this: new (...args: any[]) => T,
    data: Partial<T> | Record<string, any>,
    options: {
      cloneDeep?: boolean;
      item?: T;
      funcAllowed?: boolean;
    } = {}
  ): T {
    const item = options.item || new this();
    delete options.item;
    return item.map(data, options);
  }

  /**
   * Map method
   */
  public map(
    data: Partial<this> | Record<string, any>,
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
    } = {}
  ): this {
    return ModelHelper.map(data, this, options);
  }
}
