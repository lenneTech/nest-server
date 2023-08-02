import { CoreModel } from '../models/core-model.model';

export interface CoreModelConstructor<T extends CoreModel> {
  new (): T;
  init(this: new (...args: any[]) => T, ...args: any[]): T;
  map(
    this: new (...args: any[]) => T,
    data: Partial<T> | Record<string, any>,
    options?: {
      [key: string]: any;
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      init?: any;
      item?: T;
      mapId?: boolean;
    }
  ): T;
  mapDeep(
    this: new (...args: any[]) => T,
    data: Partial<T> | Record<string, any>,
    options: {
      [key: string]: any;
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      init?: any;
      item?: T;
      mapId?: boolean;
    }
  ): T;
}
