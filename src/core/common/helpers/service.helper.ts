import { UnauthorizedException } from '@nestjs/common';
import bcrypt = require('bcrypt');
import { sha256 } from 'js-sha256';
import _ = require('lodash');
import { Types } from 'mongoose';

import { RoleEnum } from '../enums/role.enum';
import { PrepareInputOptions } from '../interfaces/prepare-input-options.interface';
import { PrepareOutputOptions } from '../interfaces/prepare-output-options.interface';
import { ResolveSelector } from '../interfaces/resolve-selector.interface';
import { ServiceOptions } from '../interfaces/service-options.interface';
import { ConfigService } from '../services/config.service';
import { getStringIds } from './db.helper';
import { clone, plainToInstanceClean, processDeep } from './input.helper';

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
      checkRoles?: boolean;
      clone?: boolean;
      create?: boolean;
      getNewArray?: boolean;
      removeUndefined?: boolean;
      sha256?: boolean;
      targetModel?: new (...args: any[]) => T;
    } = {},
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
      objectIdsToStrings?: boolean;
      removeSecrets?: boolean;
      removeUndefined?: boolean;
      targetModel?: new (...args: any[]) => T;
    } = {},
  ): Promise<any | T | T[]> {
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
    circles?: boolean;
    clone?: boolean;
    convertObjectIdsToString?: boolean;
    create?: boolean;
    getNewArray?: boolean;
    proto?: boolean;
    removeUndefined?: boolean;
    sha256?: boolean;
    targetModel?: new (...args: any[]) => T;
  } = {},
): Promise<T> {
  // Configuration
  const config = {
    checkRoles: false,
    circles: false,
    clone: false,
    convertObjectIdsToString: true,
    create: false,
    getNewArray: false,
    proto: false,
    removeUndefined: true,
    sha256: ConfigService.configFastButReadOnly.sha256,
    ...options,
  };

  // Check input
  if (!input || typeof input !== 'object') {
    return input;
  }

  // Process array
  if (Array.isArray(input)) {
    const processedArray = config.getNewArray ? ([] as any[] & T) : input;
    for (let i = 0; i <= input.length - 1; i++) {
      processedArray[i] = await prepareInput(input[i], currentUser, options);
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
      input = clone(input, { circles: config.circles, proto: config.proto });
    }
  }

  // Convert ObjectIds to string
  if (config.convertObjectIdsToString) {
    input = processDeep(
      input,
      (property) => {
        if (property instanceof Types.ObjectId) {
          property = getStringIds(property);
        }
        return property;
      },
      { specialClasses: ['ObjectId'] },
    );
  }

  // Map input if target model exist
  if (config.targetModel && !(input instanceof config.targetModel)) {
    if ((config.targetModel as any)?.map) {
      input = await (config.targetModel as any).map(input);
    } else {
      input = plainToInstanceClean(config.targetModel, input);
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
        throw new UnauthorizedException(`Current user not allowed setting roles: ${missingRoles}`);
      }
      (input as Record<string, any>).roles = allowedRoles;
    }
  }

  // Hash password
  if ((input as any).password) {
    // Check if the password was transmitted encrypted
    // If not, the password is encrypted to enable future encrypted and unencrypted transmissions
    if (config.sha256 && !/^[a-f0-9]{64}$/i.test((input as any).password)) {
      (input as any).password = sha256((input as any).password);
    }

    // Hash password
    (input as any).password = await bcrypt.hash((input as any).password, 10);
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
    circles?: boolean;
    clone?: boolean;
    getNewArray?: boolean;
    language?: string;
    objectIdsToStrings?: boolean;
    proto?: boolean;
    removeSecrets?: boolean;
    removeUndefined?: boolean;
    targetModel?: new (...args: any[]) => T;
  } = {},
): Promise<any | T | T[]> {
  // Configuration
  const config = {
    circles: false,
    clone: false,
    getNewArray: false,
    objectIdsToStrings: true,
    proto: false,
    removeSecrets: true,
    removeUndefined: false,
    targetModel: undefined,
    ...options,
  };

  // Check output
  if (!output || typeof output !== 'object') {
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
      output = clone(output, { circles: config.circles, proto: config.proto });
    }
  }

  // Map output if target model exist
  if (config.targetModel && !(output instanceof config.targetModel)) {
    if ((config.targetModel as any)?.map) {
      output = await (config.targetModel as any).map(output);
    } else {
      output = plainToInstanceClean(config.targetModel, output);
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

  // Convert ObjectIds into strings
  if (config.objectIdsToStrings) {
    for (const [key, value] of Object.entries(output)) {
      if (value instanceof Types.ObjectId) {
        output[key] = value.toHexString();
      }
    }
  }

  // Add translated values of current selected language if _translations object exists
  if (config.targetModel && config.language && typeof output === 'object' && '_translations' in output) {
    applyTranslationsRecursively(output, config.language);
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
    circles?: boolean;
    clone?: boolean;
    inputType?: any;
    outputType?: any;
    prepareInput?: PrepareInputOptions;
    prepareOutput?: PrepareOutputOptions;
    proto?: boolean;
    subFieldSelection?: string;
  },
): ServiceOptions {
  // Set default values
  const config = {
    circles: true,
    clone: false,
    proto: false,
    ...options,
  };

  // Clone
  if (serviceOptions && config.clone) {
    serviceOptions = clone(serviceOptions, { circles: config.circles, proto: config.proto });
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
      (serviceOptions.fieldSelection as ResolveSelector).select += `.${config.subFieldSelection}`;
    }
  }

  // Return (cloned and) prepared service options
  return serviceOptions;
}

function applyTranslationsRecursively(obj: any, language: string, visited: WeakSet<object> = new WeakSet()) {
  if (typeof obj !== 'object' || obj === null) {
    return;
  }
  if (visited.has(obj)) {
    return;
  } // Cycle detected -> cancel

  visited.add(obj);

  // If _translations exists
  if ('_translations' in obj && typeof obj._translations === 'object') {
    const translation = obj._translations?.[language];
    if (typeof translation === 'object') {
      for (const key in translation) {
        if (translation[key] != null) {
          obj[key] = translation[key];
        }
      }
    }
  }

  // Recursive over all properties
  for (const key of Object.keys(obj)) {
    const value = obj[key];

    if (Array.isArray(value)) {
      for (const item of value) {
        applyTranslationsRecursively(item, language, visited);
      }
    } else if (typeof value === 'object' && value !== null) {
      applyTranslationsRecursively(value, language, visited);
    }
  }
}
