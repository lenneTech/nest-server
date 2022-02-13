import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as _ from 'lodash';
import { RoleEnum } from '../enums/role.enum';

/**
 * Helper class for services
 */
export class ServiceHelper {
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
    // Configuration
    const config = {
      checkRoles: false,
      clone: false,
      create: false,
      getNewArray: false,
      removeUndefined: false,
      ...options,
    };

    // Check input
    if (typeof input !== 'object') {
      return input;
    }

    // Process array
    if (Array.isArray(input)) {
      const processedArray = input.map(
        async (item) => await ServiceHelper.prepareInput(item, currentUser, options)
      ) as any;
      return config.getNewArray ? processedArray : input;
    }

    // Clone input
    if (config.clone) {
      if ((input as Record<string, any>).mapDeep && typeof (input as any).mapDeep === 'function') {
        input = await Object.getPrototypeOf(input).mapDeep(input);
      } else {
        input = _.cloneDeep(input);
      }
    }

    // Remove undefined properties to avoid unwanted overwrites
    if (config.removeUndefined) {
      Object.keys(input).forEach((key) => input[key] === undefined && delete input[key]);
    }

    // Process roles
    if (
      config.checkRoles &&
      (input as Record<string, any>).roles &&
      (!currentUser?.hasRole || !currentUser.hasRole(RoleEnum.ADMIN))
    ) {
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
    if ((input as Record<string, any>).password) {
      (input as Record<string, any>).password = await bcrypt.hash((input as any).password, 10);
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
    // Configuration
    const config = {
      clone: false,
      getNewArray: false,
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
      const processedArray = output.map(async (item) => await ServiceHelper.prepareOutput(item, options)) as any;
      return config.getNewArray ? processedArray : output;
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
    if (config.targetModel) {
      output = await (config.targetModel as any).map(output);
    }

    // Remove password if exists
    if (output.password) {
      output.password = undefined;
    }

    // Remove verification token if exists
    if (output.verificationToken) {
      output.verificationToken = undefined;
    }

    // Remove password reset token if exists
    if (output.passwordResetToken) {
      output.passwordResetToken = undefined;
    }

    // Remove undefined properties to avoid unwanted overwrites
    if (config.removeUndefined) {
      Object.keys(output).forEach((key) => output[key] === undefined && delete output[key]);
    }

    // Return prepared output
    return output;
  }
}
