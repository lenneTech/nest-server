import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { plainToInstance } from 'class-transformer';
import { sha256 } from 'js-sha256';
import * as _ from 'lodash';
import { RoleEnum } from '../enums/role.enum';
import { PrepareInputOptions } from '../interfaces/prepare-input-options.interface';
import { PrepareOutputOptions } from '../interfaces/prepare-output-options.interface';
import { ResolveSelector } from '../interfaces/resolve-selector.interface';
import { ServiceOptions } from '../interfaces/service-options.interface';

/**
 * Helper class for services
 * @deprecated use functions directly
 */
export default class ServiceHelper {
  /**
   * Prepare input before save
   */
  static async prepareInput<T = any>(
    input: T,
    currentUser: { [key: string]: any; id: string },
    options: {
      [key: string]: any;
      create?: boolean;
      clone?: boolean;
      getNewArray?: boolean;
      removeUndefined?: boolean;
    } = {}
  ): Promise<T> {
    return prepareInput(input, currentUser, options);
  }

  /**
   * Prepare output before return
   */
  static async prepareOutput<T = { [key: string]: any; map: (...args: any[]) => any }>(
    output: any,
    options: {
      [key: string]: any;
      clone?: boolean;
      getNewArray?: boolean;
      removeUndefined?: boolean;
      targetModel?: new (...args: any[]) => T;
    } = {}
  ): Promise<T | T[] | any> {
    return prepareOutput(output, options);
  }
}

/**
 * Prepare input before save
 */
export async function prepareInput<T = any>(
  input: T,
  currentUser: { [key: string]: any; id: string },
  options: {
    [key: string]: any;
    checkRoles?: boolean;
    create?: boolean;
    clone?: boolean;
    getNewArray?: boolean;
    removeUndefined?: boolean;
    targetModel?: new (...args: any[]) => T;
  } = {}
): Promise<T> {
  // Configuration
  const config = {
    checkRoles: false,
    clone: false,
    create: false,
    getNewArray: false,
    removeUndefined: true,
    ...options,
  };

  // Check input
  if (typeof input !== 'object') {
    return input;
  }

  // Process array
  if (Array.isArray(input)) {
    const processedArray = config.getNewArray ? ([] as T & any[]) : input;
    for (let i = 0; i <= input.length - 1; i++) {
      processedArray[i] = await prepareOutput(input[i], options);
      if (processedArray[i] === undefined && config.removeUndefined) {
        processedArray.splice(i, 1);
      }
    }
    return processedArray;
  }

  // Clone input
  if (config.clone) {
    if ((input as Record<string, any>).mapDeep && typeof (input as any).mapDeep === 'function') {
      input = await Object.getPrototypeOf(input).mapDeep(input);
    } else {
      input = _.cloneDeep(input);
    }
  }

  // Map input if target model exist
  if (config.targetModel && !(input instanceof config.targetModel)) {
    if ((config.targetModel as any)?.map) {
      input = await (config.targetModel as any).map(input);
    } else {
      input = plainToInstance(config.targetModel, input);
    }
  }

  // Remove undefined properties to avoid unwanted overwrites
  for (const [key, value] of Object.entries(input)) {
    value === undefined && delete input[key];
  }

  // Process roles
  if (config.checkRoles && (input as Record<string, any>).roles && !currentUser?.hasRole?.(RoleEnum.ADMIN)) {
    if (!(currentUser as any)?.roles) {
      throw new UnauthorizedException('Missing roles of current user');
    } else {
      const allowedRoles = _.intersection((input as Record<string, any>).roles, (currentUser as any).roles);
      if (allowedRoles.length !== (input as Record<string, any>).roles.length) {
        const missingRoles = _.difference((input as Record<string, any>).roles, (currentUser as any).roles);
        throw new UnauthorizedException('Current user not allowed setting roles: ' + missingRoles);
      }
      (input as Record<string, any>).roles = allowedRoles;
    }
  }

  // Hash password
  if ((input as any).password) {
    // Check if the password was transmitted encrypted
    // If not, the password is encrypted to enable future encrypted and unencrypted transmissions
    (input as any).password = /^[a-f0-9]{64}$/i.test((input as any).password)
      ? (input as any).password
      : sha256((input as any).password);

    // Hash password
    (input as any).password = await bcrypt.hash((input as any).password, 10);
  }

  // Set creator
  if (config.create && currentUser) {
    (input as Record<string, any>).createdBy = currentUser.id;
  }

  // Set updater
  if (currentUser) {
    (input as Record<string, any>).updatedBy = currentUser.id;
  }

  // Return prepared input
  return input;
}

/**
 * Prepare output before return
 */
export async function prepareOutput<T = { [key: string]: any; map: (...args: any[]) => any }>(
  output: any,
  options: {
    [key: string]: any;
    clone?: boolean;
    getNewArray?: boolean;
    removeSecrets?: boolean;
    removeUndefined?: boolean;
    targetModel?: new (...args: any[]) => T;
  } = {}
): Promise<T | T[] | any> {
  // Configuration
  const config = {
    clone: false,
    getNewArray: false,
    removeSecrets: true,
    removeUndefined: false,
    targetModel: undefined,
    ...options,
  };

  // Check output
  if (typeof output !== 'object') {
    return output;
  }

  // Process array
  if (Array.isArray(output)) {
    const processedArray = config.getNewArray ? [] : output;
    for (let i = 0; i <= output.length - 1; i++) {
      processedArray[i] = await prepareOutput(output[i], options);
      if (processedArray[i] === undefined && config.removeUndefined) {
        processedArray.splice(i, 1);
      }
    }
    return processedArray;
  }

  // Clone output
  if (config.clone) {
    if (output.mapDeep && typeof output.mapDeep === 'function') {
      output = await Object.getPrototypeOf(output).mapDeep(output);
    } else {
      output = _.cloneDeep(output);
    }
  }

  // Map output if target model exist
  if (config.targetModel && !(output instanceof config.targetModel)) {
    if ((config.targetModel as any)?.map) {
      output = await (config.targetModel as any).map(output);
    } else {
      output = plainToInstance(config.targetModel, output);
    }
  }

  // Remove password if exists
  if (config.removeSecrets && output.password) {
    output.password = undefined;
  }

  // Remove verification token if exists
  if (config.removeSecrets && output.verificationToken) {
    output.verificationToken = undefined;
  }

  // Remove password reset token if exists
  if (config.removeSecrets && output.passwordResetToken) {
    output.passwordResetToken = undefined;
  }

  // Remove undefined properties to avoid unwanted overwrites
  if (config.removeUndefined) {
    for (const [key, value] of Object.entries(output)) {
      value === undefined && delete output[key];
    }
  }

  // Return prepared output
  return output;
}

/**
 * Prepare service options
 */
export function prepareServiceOptions(
  serviceOptions: ServiceOptions,
  options?: {
    clone?: boolean;
    inputType?: any;
    outputType?: any;
    subFieldSelection?: string;
    prepareInput?: PrepareInputOptions;
    prepareOutput?: PrepareOutputOptions;
  }
): ServiceOptions {
  // Set default values
  const config = {
    clone: true,
    ...options,
  };

  // Clone
  if (serviceOptions && config.clone) {
    serviceOptions = _.cloneDeep(serviceOptions);
  }

  // Init if not exists
  serviceOptions = serviceOptions || {};

  // Set properties
  serviceOptions.inputType = serviceOptions.inputType || options?.inputType;
  serviceOptions.outputType = serviceOptions.outputType || options?.outputType;

  // Set properties which can deactivate handling when falsy
  if (!serviceOptions.prepareInput && 'prepareInput' in config) {
    serviceOptions.prepareInput = config.prepareInput;
  }
  if (!serviceOptions.prepareOutput && 'prepareOutput' in config) {
    serviceOptions.prepareOutput = config.prepareOutput;
  }

  // Set subfield selection
  if (config.subFieldSelection) {
    if ((serviceOptions.fieldSelection as ResolveSelector)?.select) {
      (serviceOptions.fieldSelection as ResolveSelector).select += '.' + config.subFieldSelection;
    }
  }

  // Return (cloned and) prepared service options
  return serviceOptions;
}
