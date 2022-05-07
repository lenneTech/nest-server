import { Document, Model, Types } from 'mongoose';
import { ProcessType } from '../enums/process-type.enum';
import { getStringIds, popAndMap } from '../helpers/db.helper';
import { check } from '../helpers/input.helper';
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
   * Check rights of current user for input
   */
  checkRights(
    input: any,
    currentUser: { id: any; hasRole: (roles: string[]) => boolean },
    options?: {
      dbObject?: any;
      metatype?: any;
      processType?: ProcessType;
      roles?: string | string[];
      throwError?: boolean;
    }
  ): Promise<any> {
    const config = {
      metatype: this.mainModelConstructor,
      ...options,
    };
    return check(input, currentUser, config);
  }

  /**
   * Get function to get Object via ID, necessary for checkInput
   */
  abstract get(id: any, ...args: any[]): any;

  /**
   * Run service function with pre- and post-functions
   */
  async process(
    serviceFunc: (options?: { [key: string]: any; input?: any; serviceOptions?: ServiceOptions }) => any,
    options?: {
      [key: string]: any;
      dbObject?: string | Types.ObjectId | any;
      input?: any;
      serviceOptions?: ServiceOptions;
    }
  ) {
    // Configuration with default values
    const config = {
      checkRights: true,
      dbObject: options?.dbObject,
      input: options?.input,
      processFieldSelection: {},
      prepareInput: {},
      prepareOutput: {},
      pubSub: true,
      ...options?.serviceOptions,
    };

    // Prepare input
    if (config.prepareInput && this.prepareInput) {
      await this.prepareInput(config.input, config.prepareInput);
    }

    // Get DB object
    if (config.dbObject && config.checkRights && this.checkRights) {
      if (typeof config.dbObject === 'string' || config.dbObject instanceof Types.ObjectId) {
        const dbObject = await this.get(getStringIds(config.dbObject));
        if (dbObject) {
          config.dbObject = dbObject;
        }
      }
    }

    // Check rights for input
    if (config.input && config.checkRights && this.checkRights) {
      const opts: any = { dbObject: config.dbObject, processType: ProcessType.INPUT, roles: config.roles };
      if (config.inputType) {
        opts.metatype = config.resultType;
      }
      config.input = await this.checkRights(config.input, config.currentUser as any, opts);
    }

    // Run service function
    let result = await serviceFunc(config);

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
      result = await this.prepareOutput(result, config.prepareOutput);
    }

    // Check output rights
    if (config.checkRights && this.checkRights) {
      const opts: any = {
        dbObject: config.dbObject,
        processType: ProcessType.OUTPUT,
        roles: config.roles,
        throwError: false,
      };
      if (config.resultType) {
        opts.metatype = config.resultType;
      }
      result = await this.checkRights(result, config.currentUser as any, opts);
    }

    // Return (prepared) result
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
