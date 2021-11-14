import * as _ from 'lodash';
import { IServerOptions } from '../interfaces/server-options.interface';

/**
 * Config service
 */
export class ConfigService {
  /**
   * Configuration on startup
   */
  protected readonly _config: { [key: string]: any } & Partial<IServerOptions>;

  /**
   * Create config service
   */
  constructor(config: { [key: string]: any } & Partial<IServerOptions>) {
    this._config = config || {};
  }

  /**
   * Get config (deep cloned to avoid unwanted side effects)
   */
  get config() {
    return _.cloneDeep(this._config);
  }

  /**
   * Get data from config (deep cloned to avoid unwanted side effects)
   * @param key Property name of config object, which is to be returned
   * @param defaultValue Default value which is to be returned if property doesn't exist
   */
  get(key: string, defaultValue: any = undefined) {
    return _.cloneDeep(_.get(this._config, key, defaultValue));
  }
}
