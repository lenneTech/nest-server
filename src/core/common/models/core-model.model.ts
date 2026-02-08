import { map } from '../helpers/model.helper';

/**
 * Core Model
 *
 * HINT: All properties (in this class and all classes that extend this class) must be initialized with a default
 * value or undefined otherwise the property will not be recognized via Object.keys (this is necessary for mapping).
 * If the property is initialized with a default value (e.g. an empty array or boolean), there is a risk that the
 * current value will be overwritten during mapping without this being intentional, so all values should be initialized
 * with undefined if possible. If necessary and useful, the init method can then be used deliberately:
 * const coreModel = item ? CoreModel.map(item).init() : CoreModel.init();
 */
export abstract class CoreModel {
  /**
   * Static init method
   */
  public static init<T extends CoreModel>(this: new (...args: any[]) => T, ...args: any[]): T {
    const item = new this();
    return item.init(args);
  }

  /**
   * Static map method
   */
  public static map<T extends CoreModel>(
    this: new (...args: any[]) => T,
    data: Partial<T> | Record<string, any>,
    options: {
      [key: string]: any;
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      init?: any;
      item?: T;
      mapId?: boolean;
    } = {},
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
      [key: string]: any;
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      init?: any;
      item?: T;
      mapId?: boolean;
    } = {},
  ): T {
    const item = options.item || new this();
    delete options.item;
    return item.mapDeep(data, options);
  }

  /**
   * Initialize instance with default values instead of undefined
   * Should be overwritten in child class to organize the defaults
   */
  public init(...args: any[]): this {
    return this;
  }

  /**
   * Map method
   */
  public map(
    data: Partial<this> | Record<string, any>,
    options: {
      [key: string]: any;
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      init?: any;
      mapId?: boolean;
    } = {},
  ): this {
    const config = {
      cloneDeep: false,
      funcAllowed: false,
      init: undefined,
      mapId: false,
      ...options,
    };
    if (config.init) {
      this.init(config.init);
    }
    return map(data, this, config);
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
      [key: string]: any;
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      init?: any;
      mapId?: boolean;
    } = {},
  ): this {
    const config = {
      cloneDeep: true,
      funcAllowed: false,
      init: undefined,
      mapId: false,
      ...options,
    };
    return this.map(data, config);
  }

  /**
   * Verification of the user's rights to access the properties of this object
   */
  public securityCheck(user: any, force?: boolean): this {
    return this;
  }
}
