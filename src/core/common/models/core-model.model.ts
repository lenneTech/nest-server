import * as _ from 'lodash';

export abstract class CoreModel {
  public static map<T extends CoreModel>(
    this: new (...args: any[]) => T,
    data: any,
    item: T = new this(),
  ): T {
    return item.map(data);
  }

  public map<T extends CoreModel>(
    this: T,
    data: object,
    cloneDeep: boolean = true,
  ): T {
    return Object.keys(this).reduce((obj, key) => {
      obj[key] = cloneDeep ? _.cloneDeep(data[key]) : data[key];
      return obj;
    }, this);
  }
}
