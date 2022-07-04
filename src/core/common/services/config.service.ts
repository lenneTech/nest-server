import * as _ from 'lodash';
import { cloneDeep } from 'lodash';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { merge } from '../helpers/config.helper';
import { deepFreeze } from '../helpers/input.helper';
import { IServerOptions } from '../interfaces/server-options.interface';

/**
 * Config service can be used as provider (after initialization in CoreModule.forRoot)
 *
 * Note:
 *
 * Direct access to the global configuration is not intended, since all objects in JavaScript interact by reference
 * it can come to unintentional changes. Two protected properties are available for access `config` and `configClone`,
 * as well as several methods that use these properties.
 *
 * The return value of `config` is a cached deep frozen object to speed up access and to avoid unwanted side
 * effects (like accidentally changing the global configuration). However, this results in the object and all its
 * contents being read-only. Attempts to change the configuration will result in the
 * `TypeError: Cannot assign to read only property ...` If this error occurs during further processing of the
 * configuration, `configClone` should be used instead of `config`. The access to this form of the configuration is
 * substantially slower, but offers the advantage that the clone can be processed further (also without changing the
 * global configuration).
 *
 * `config` => fast read only copy of global configuration
 *            (return value of get, observable and promise)
 *
 * `configClone` => slow read and writeable copy of global configuration
 *                  (return value of getClone, observableClone and promiseClone)
 */
export class ConfigService {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * BehaviorSubject for config
   */
  protected static _configSubject$: BehaviorSubject<{ [key: string]: any } & Partial<IServerOptions>> =
    new BehaviorSubject(undefined);

  /**
   * BehaviorSubject for frozen config
   */
  protected static _frozenConfigSubject$: BehaviorSubject<{ [key: string]: any } & Partial<IServerOptions>> =
    new BehaviorSubject(undefined);

  /**
   * Singleton instance of ConfigService
   */
  protected static _instance: ConfigService;

  // ===================================================================================================================
  // Constructor
  // ===================================================================================================================

  /**
   * Create config service or return singleton instance if exists
   */
  constructor(
    configObject?: { [key: string]: any } & Partial<IServerOptions>,
    options?: { reInit?: boolean; warn?: boolean }
  ) {
    const config = {
      reInit: false,
      warn: true,
      ...options,
    };

    // Check initialization status
    const isInitialized = ConfigService.isInitialized;

    // Init subject handling
    if (!isInitialized) {
      ConfigService._configSubject$.subscribe((config) => {
        ConfigService._frozenConfigSubject$.next(deepFreeze(config));
      });
    }

    // Set config before setting instance
    if (typeof configObject === 'object') {
      isInitialized
        ? ConfigService.mergeConfig(configObject, { ...config, ...{ init: false } })
        : ConfigService.setConfig(configObject, { ...config, ...{ init: false } });
    }

    // Set instance if not yet initialized
    if (!isInitialized) {
      ConfigService._instance = this;
    }

    // Return instance
    return ConfigService._instance;
  }

  // ===================================================================================================================
  // Getter / Queries
  // ===================================================================================================================

  /**
   * Get fast read-only deep-frozen config
   */
  get config() {
    return ConfigService.config;
  }

  /**
   * Get fast read-only deep-frozen config
   */
  static get config() {
    return ConfigService._frozenConfigSubject$.getValue();
  }

  /**
   * Get slow readable and writable deep-cloned configuration
   */
  get configClone() {
    return ConfigService.configClone;
  }

  /**
   * Get slow readable and writable deep-cloned configuration
   */
  static get configClone() {
    return _.cloneDeep(ConfigService._configSubject$.getValue());
  }

  /**
   * Get deep-frozen data from config (readonly, to avoid unwanted side effects)
   */
  get(key: string, defaultValue: any = undefined) {
    return ConfigService.get(key, defaultValue);
  }

  /**
   * Get deep-frozen data from config (readonly, to avoid unwanted side effects)
   */
  static get(key: string, defaultValue: any = undefined) {
    return _.get(ConfigService._frozenConfigSubject$.getValue(), key, defaultValue);
  }

  /**
   * Get deep-frozen data from config (readonly, to avoid unwanted side effects)
   */
  getClone(key: string, defaultValue: any = undefined) {
    return ConfigService.getClone(key, defaultValue);
  }

  /**
   * Get deep-frozen data from config (readonly, to avoid unwanted side effects)
   */
  static getClone(key: string, defaultValue: any = undefined) {
    return _.cloneDeep(_.get(ConfigService._configSubject$.getValue(), key, defaultValue));
  }

  /**
   * Whether the ConfigService is initialized
   */
  get isInitialized() {
    return ConfigService.isInitialized;
  }

  /**
   * Whether the ConfigService is initialized
   */
  static get isInitialized() {
    return !!ConfigService._instance;
  }

  /**
   * Get observable for deep frozen config
   */
  get observable() {
    return ConfigService.observable;
  }

  /**
   * Get observable for deep frozen config
   */
  static get observable() {
    return ConfigService._frozenConfigSubject$.asObservable().pipe(filter((config) => !config));
  }

  /**
   * Get observable for deep cloned config
   */
  get observableClone() {
    return ConfigService.observable;
  }

  /**
   * Get observable for deep cloned config
   */
  static get observableClone() {
    return ConfigService._configSubject$.asObservable().pipe(
      filter((config) => !config),
      map((config) => cloneDeep(config))
    );
  }

  /**
   * Get promise of first deep frozen config
   */
  get promise() {
    return ConfigService.promise;
  }

  /**
   * Get promise of first deep frozen config
   */
  static get promise() {
    return firstValueFrom(ConfigService.observable);
  }

  /**
   * Get promise of first deep cloned config
   */
  get promiseClone() {
    return ConfigService.promiseClone;
  }

  /**
   * Get promise of first deep cloned config
   */
  static get promiseClone() {
    return firstValueFrom(ConfigService.observableClone);
  }

  // ===================================================================================================================
  // Setter / Mutations
  // ===================================================================================================================

  /**
   * Merge config and set in ConfigService
   */
  mergeConfig(configData: { [key: string]: any } & Partial<IServerOptions>, options?: { warn?: boolean }) {
    return ConfigService.mergeConfig(configData, options);
  }

  /**
   * Merge config and set in ConfigService
   */
  static mergeConfig(
    configData: { [key: string]: any } & Partial<IServerOptions>,
    options?: { init?: boolean; warn?: boolean }
  ) {
    const config = {
      init: true,
      warn: false,
      ...options,
    };

    // Get initialization status
    const isInitialized = ConfigService.isInitialized;

    // Init config service instance, if not yet initialized
    if (!isInitialized && config.init) {
      new ConfigService();
    }

    // Merge config
    const activity = isInitialized ? 'merged' : 'initialized';
    const merged = merge(ConfigService._configSubject$.getValue() || {}, cloneDeep(configData));
    ConfigService._configSubject$.next(merged);

    // Warn if requested
    if (config.warn) {
      console.warn('ConfigService ' + activity, JSON.stringify(merged, null, 2));
    }

    // Return configuration
    return ConfigService.config;
  }

  /**
   * Merge config property and set in ConfigService
   */
  mergeProperty(key: string, value: any, options?: { warn?: boolean }) {
    return ConfigService.mergeProperty(key, options);
  }

  /**
   * Merge config property and set in ConfigService
   */
  static mergeProperty(key: string, value: any, options?: { warn?: boolean }) {
    const config = {
      warn: false,
      ...options,
    };

    // Init config service instance, if not yet initialized
    if (!ConfigService.isInitialized) {
      new ConfigService();
    }

    // Merge property
    const current = ConfigService._configSubject$.getValue() || {};
    if (typeof value === 'object') {
      current[key] = merge(current[key], cloneDeep(value));
    } else {
      current[key] = value;
    }
    ConfigService._configSubject$.next(current);

    // Warn if requested
    if (config.warn) {
      console.warn('ConfigService ' + key + ':', JSON.stringify(current[key], null, 2));
    }

    // Return configuration
    return ConfigService.config;
  }

  /**
   * Set config in ConfigService
   */
  setConfig(
    configData: { [key: string]: any } & Partial<IServerOptions>,
    options?: { reInit?: boolean; warn?: boolean }
  ) {
    return ConfigService.setConfig(configData, options);
  }

  /**
   * Set config in ConfigService
   */
  static setConfig(
    configObject: { [key: string]: any } & Partial<IServerOptions>,
    options?: { init?: boolean; reInit?: boolean; warn?: boolean }
  ) {
    const config = {
      init: true,
      reInit: true,
      warn: false,
      ...options,
    };

    // Check initialization
    const firstInitialization = !ConfigService.isInitialized;

    // Check for unintentional overwriting
    if (!firstInitialization && !config.reInit) {
      throw new Error(
        'Unintentional overwriting of the configuration. ' +
          'If overwriting is desired, please set `reInit` in setConfig of ConfigService to `true`.'
      );
    }

    // Init config service instance, if not yet initialized
    if (firstInitialization && config.init) {
      new ConfigService();
    }

    // (Re)Init
    if (firstInitialization || config.reInit) {
      ConfigService._configSubject$.next(configObject || {});

      // Warn if requested
      if (config.warn && !firstInitialization) {
        console.warn('ConfigService reinitialized', JSON.stringify(configObject, null, 2));
      }
    }

    // Return configuration
    return ConfigService.config;
  }

  /**
   * Set config property in ConfigService
   */
  setProperty(key: string, value: any, options?: { warn?: boolean }) {
    return ConfigService.setProperty(key, options);
  }

  /**
   * Set config property in ConfigService
   */
  static setProperty(key: string, value: any, options?: { warn?: boolean }) {
    const config = {
      warn: false,
      ...options,
    };

    // Init config service instance
    if (!ConfigService.isInitialized) {
      new ConfigService();
    }

    // Set property
    const current = ConfigService._configSubject$.getValue() || {};
    current[key] = value;
    ConfigService._configSubject$.next(current);
    if (config.warn) {
      console.warn('ConfigService ' + key + ':', JSON.stringify(value, null, 2));
    }

    // Return config
    return ConfigService.config;
  }
}
