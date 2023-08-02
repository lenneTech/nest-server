import _ = require('lodash');
import { Document, Model, Types } from 'mongoose';
import { ProcessType } from '../enums/process-type.enum';
import { getStringIds, popAndMap } from '../helpers/db.helper';
import { check } from '../helpers/input.helper';
import { prepareInput, prepareOutput } from '../helpers/service.helper';
import { ServiceOptions } from '../interfaces/service-options.interface';
import { CoreModel } from '../models/core-model.model';
import { FieldSelection } from '../types/field-selection.type';
import { ConfigService } from './config.service';

/**
 * Module service class to be extended by concrete module services
 */
export abstract class ModuleService<T extends CoreModel = any> {
  /**
   * Config service, is used to determine certain behavior
   */
  protected configService: ConfigService;

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
    configService?: ConfigService;
    mainDbModel?: Model<T & Document>;
    mainModelConstructor?: new (...args: any[]) => T;
  }) {
    this.configService = options?.configService;
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
    },
  ): Promise<any> {
    const config = {
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
      outputPath?: string | string[];
      input?: any;
      serviceOptions?: ServiceOptions;
    },
  ) {
    // Configuration with default values
    const config: {
      dbObject: string | Types.ObjectId | any;
      outputPath: string | string[];
      input: any;
    } & ServiceOptions = {
      checkRights: true,
      dbObject: options?.dbObject,
      outputPath: options?.outputPath,
      force: false,
      input: options?.input,
      processFieldSelection: {},
      prepareInput: {},
      prepareOutput: {},
      pubSub: true,
      setCreateOrUpdateUserId: true,
      ...options?.serviceOptions,
    };

    // Set default for ignoreSelections if not set
    const ignoreSelections = this.configService?.getFastButReadOnly('ignoreSelectionsForPopulate', true);
    if (ignoreSelections) {
      if (config.processFieldSelection.ignoreSelections === undefined) {
        config.processFieldSelection.ignoreSelections = ignoreSelections;
      }
    }

    // Note force configuration
    if (config.force) {
      config.checkRights = false;
      if (config.prepareInput && typeof config.prepareInput === 'object') {
        config.prepareInput.checkRoles = false;
      }
      if (config.prepareOutput && typeof config.prepareOutput === 'object') {
        config.prepareOutput.removeSecrets = false;
      }
    }

    // Note populate
    if (config.populate) {
      config.fieldSelection = config.populate;
      if (config.processFieldSelection?.ignoreSelections) {
        config.processFieldSelection.ignoreSelections = false;
      }
    }

    // Prepare input
    if (config.prepareInput && this.prepareInput) {
      const opts = config.prepareInput;
      if (!opts.targetModel && config.inputType) {
        opts.targetModel = config.inputType;
      }
      config.input = await this.prepareInput(config.input, config);
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
        opts.metatype = config.inputType;
      }
      config.input = await this.checkRights(config.input, config.currentUser as any, opts);

      // Check roles before processing the service function if they were not already checked during the input check
    } else if (!config.input && config.checkRights && this.checkRights) {
      await this.checkRights(undefined, config.currentUser as any, config);
    }

    if (config.input && config.currentUser && config.setCreateOrUpdateUserId) {
      // Set creator
      if (config.create) {
        (config.input as Record<string, any>).createdBy = config.currentUser.id;
      }

      // Set updater
      (config.input as Record<string, any>).updatedBy = config.currentUser.id;
    }

    // Run service function
    let result = await serviceFunc(config);

    // Pop and map main model
    if (config.processFieldSelection && config.fieldSelection && this.processFieldSelection) {
      const field = config.outputPath ? _.get(result, config.outputPath) : result;
      await this.processFieldSelection(field, config.fieldSelection, config.processFieldSelection);
    }

    // Prepare output
    if (config.prepareOutput && this.prepareOutput) {
      const opts = config.prepareOutput;
      if (!opts.targetModel && config.outputType) {
        opts.targetModel = config.outputType;
      }
      if (config.outputPath) {
        _.set(result, config.outputPath, await this.prepareOutput(_.get(result, config.outputPath), opts));
      } else {
        result = await this.prepareOutput(result, config);
      }
    }

    // Check output rights
    if (config.checkRights && (await this.checkRights(undefined, config.currentUser as any, config))) {
      const opts: any = {
        dbObject: config.dbObject,
        processType: ProcessType.OUTPUT,
        roles: config.roles,
        throwError: false,
      };
      if (config.outputType) {
        opts.metatype = config.outputType;
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
    const config = {
      ...options?.prepareInput,
    };
    return prepareInput(input, options.currentUser, config);
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
      ignoreSelections?: boolean;
    } = {},
  ) {
    const config = {
      model: this.mainModelConstructor,
      dbModel: this.mainDbModel,
      ...options,
    };
    return popAndMap(data, fieldsSelection, config.model, config.dbModel, {
      ignoreSelections: config.ignoreSelections,
    });
  }
}
