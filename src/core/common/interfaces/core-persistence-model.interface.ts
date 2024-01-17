import { CorePersistenceModel } from '../../..';

export interface ICorePersistenceModel<T extends CorePersistenceModel = any> {
  [key: string]: any;
  init(this: new (...args: any[]) => T, ...args: any[]): any;
  map(
    this: new (...args: any[]) => T,
    data: Partial<T> | Record<string, any>,
    options?: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      mapId?: boolean;
      merge?: boolean;
    },
  ): any;
  new (): T;
}
