import { Document, Model } from 'mongoose';
import { popAndMap } from '../helpers/db.helper';
import { prepareInput, prepareOutput } from '../helpers/service.helper';
import { ServiceOptions } from '../interfaces/service-options.interface';
import { CoreModel } from '../models/core-model.model';
import { FieldSelection } from '../types/field-selection.type';

/**
 * Module service class to be extended by concrete module services
 */
export abstract class ModuleService<T extends CoreModel = any> {
  /**
   * Main model constructor of the service, will be used as default for populate and mapping
   */
  protected mainModelConstructor: new (...args: any[]) => T;

  /**
   * Main DB model of the service, will be used as default for populate and mapping
   */
  protected mainDbModel: Model<T & Document>;

  /**
   * Set main properties
   */
  protected constructor(options?: {
    mainDbModel: Model<T & Document>;
    mainModelConstructor?: new (...args: any[]) => T;
  }) {
    this.mainDbModel = options?.mainDbModel;
    this.mainModelConstructor = options?.mainModelConstructor;
  }

  /**
   * Run service function with pre- and post-functions
   */
  async process(
    serviceFunc: (options?: { [key: string]: any; input?: any; serviceOptions?: ServiceOptions }) => any,
    options?: { [key: string]: any; input?: any; serviceOptions?: ServiceOptions }
  ) {
    // Configuration with default values
    const config = {
      currentUser: null,
      fieldSelection: null,
      processFieldSelection: {},
      prepareInput: {},
      prepareOutput: {},
      pubSub: true,
      ...options?.serviceOptions,
    };

    // Prepare input
    if (config.prepareInput && this.prepareInput) {
      await this.prepareInput(options?.input, config.prepareInput);
    }

    // Run service function
    const result = await serviceFunc(options);

    // Pop and map main model
    if (config.processFieldSelection && config.fieldSelection && this.processFieldSelection) {
      await this.processFieldSelection(result, config.fieldSelection, config.processFieldSelection);
    }

    // Prepare output
    if (config.prepareOutput && this.prepareOutput) {
      // Check if mapping is already done by processFieldSelection
      if (config.processFieldSelection && config.fieldSelection && this.processFieldSelection) {
        config.prepareOutput.targetModel = null;
      }
      return this.prepareOutput(result, config.prepareOutput);
    }

    // Return result without output preparation
    return result;
  }

  /**
   * Prepare input before save
   */
  async prepareInput(input: Record<string, any>, options: ServiceOptions = {}) {
    return prepareInput(input, options.currentUser, options.prepareInput);
  }

  /**
   * Prepare output before return
   */
  async prepareOutput(output: any, options: ServiceOptions = {}) {
    const config = {
      targetModel: this.mainModelConstructor,
      ...options?.prepareOutput,
    };
    return prepareOutput(output, config);
  }

  /**
   * Process fieldSelection
   * @protected
   */
  async processFieldSelection(
    data: any,
    fieldsSelection: FieldSelection,
    options: {
      model?: new (...args: any[]) => T;
      dbModel?: Model<T & Document>;
    } = {}
  ) {
    const config = {
      model: this.mainModelConstructor,
      dbModel: this.mainDbModel,
      ...options,
    };
    return popAndMap(data, fieldsSelection, config.model, config.dbModel);
  }
}
