import { CorePersistenceModel } from '../../..';

export interface ICorePersistenceModel<T extends CorePersistenceModel = any> {
  new (): T;
  map(
    this: new (...args: any[]) => T,
    data: Partial<T> | Record<string, any>,
    options?: {
      cloneDeep?: boolean;
      item?: T;
      funcAllowed?: boolean;
    }
  ): any;
  [key: string]: any;
}
