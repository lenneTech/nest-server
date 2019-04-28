import * as _ from 'lodash';
import { IServerOptions } from '../interfaces/server-options.interface';

/**
 * Config service
 */
export class ConfigService {

  /**
   * Configuration on startup
   */
  private readonly _config: { [key: string]: any } & Partial<IServerOptions>;

  /**
   * Create config service
   */
  constructor(config: { [key: string]: any } & Partial<IServerOptions>) {
    this._config = config;
  }

  /**
   * Get config
   */
  get config() {
    return _.cloneDeep(this._config);
  }

  /**
   * Get data from config
   */
  get(key: string) {
    return _.cloneDeep(_.get(this._config, key, undefined));
  }
}
