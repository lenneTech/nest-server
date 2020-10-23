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
      funcAllowed?: boolean;
      item?: T;
      mapId?: boolean;
    } = {}
  ): T {
    const item = options.item || new this();
    delete options.item;
    return item.map(data, options);
  }

  /**
   * Static map deep method
   *
   * Alias for map with cloneDeep = true
   *
   * MapDeep prevents side effects, because objects will be cloned
   * (cloneDeep = true), but it will be slower than a simple map
   */
  public static mapDeep<T extends CoreModel>(
    this: new (...args: any[]) => T,
    data: Partial<T> | Record<string, any>,
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      item?: T;
      mapId?: boolean;
    } = {}
  ): T {
    const item = options.item || new this();
    delete options.item;
    return item.mapDeep(data, options);
  }

  /**
   * Map method
   */
  public map(
    data: Partial<this> | Record<string, any>,
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      mapId?: boolean;
    } = {}
  ): this {
    // For MakroORM ignore id and _id during the mapping by default
    const config = {
      cloneDeep: false,
      funcAllowed: false,
      mapId: true,
      ...options,
    };
    return ModelHelper.map(data, this, config);
  }

  /**
   * Map deep method
   *
   * Alias for map with cloneDeep = true
   *
   * MapDeep prevents side effects, because objects will be cloned
   * (cloneDeep = true), but it will be slower than a simple map
   */
  public mapDeep(
    data: Partial<this> | Record<string, any>,
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      mapId?: boolean;
    } = {}
  ): this {
    // For MakroORM ignore id and _id during the mapping by default
    const config = {
      cloneDeep: true,
      funcAllowed: false,
      mapId: true,
      ...options,
    };
    return this.map(data, config);
  }
}
