import * as _ from 'lodash';
import { ServerOptions } from '../interfaces/server-options.interface';

/**
 * Config service
 */
export class ConfigService {

  /**
   * Configuration on startup
   */
  private readonly _config: { [key: string]: any } & Partial<ServerOptions>;

  /**
   * Create config service
   */
  constructor(config: { [key: string]: any } & Partial<ServerOptions>) {
    this._config = config;
  }

  /**
   * Get data from config
   */
  get(key: string) {
    return _.cloneDeep(_.get(this._config, key, undefined));
  }

  /**
   * Get config
   */
  get config() {
    return _.cloneDeep(this._config);
  }
}
