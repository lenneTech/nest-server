import { map } from '../helpers/model.helper';
import { CoreModel } from '../models/core-model.model';

/**
 * Core Input
 *
 * All properties (in this class and all classes that extend this class) must be initialized with undefined!
 *
 * In contrast to the core model, properties that are undefined are completely removed from the instance during mapping,
 * so that no existing data is overwritten when a data set is updated, for example. However, re-mapping causes the
 * removed properties to be ignored and no longer automatically integrated into the instance. They must then be
 * reactivated by direct assignment `instance.property = ...`.
 */
export abstract class CoreInput extends CoreModel {
  /**
   * Map method
   */
  public override map(
    data: Partial<this> | Record<string, any>,
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      mapId?: boolean;
    } = {}
  ): this {
    const config = {
      cloneDeep: false,
      funcAllowed: false,
      mapId: false,
      ...options,
    };
    const coreInput = map(data, this, config);
    Object.keys(coreInput).forEach((key) => coreInput[key] === undefined && delete coreInput[key]);
    return coreInput;
  }
}
