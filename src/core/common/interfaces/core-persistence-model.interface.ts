import { EntityManager } from '@mikro-orm/core';
import { CorePersistenceModel } from '../../..';

export interface ICorePersistenceModel<T extends CorePersistenceModel = any> {
  new (): T;
  map(
    this: new (...args: any[]) => T,
    data: Partial<T> | Record<string, any>,
    options?: {
      cloneDeep?: boolean;
      em?: EntityManager;
      funcAllowed?: boolean;
      mapId?: boolean;
      merge?: boolean;
    }
  ): any;
  [key: string]: any;
}
