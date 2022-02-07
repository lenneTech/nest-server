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
  static async prepareInput(
    input: Record<string, any>,
    currentUser: { [key: string]: any; id: string },
    options: { [key: string]: any; create?: boolean; clone?: boolean; removeUndefined?: boolean } = {}
  ) {
    // Configuration
    const config = {
      checkRoles: false,
      clone: false,
      create: false,
      removeUndefined: false,
      ...options,
    };

    // Clone input
    if (config.clone) {
      if (input.mapDeep && typeof input.mapDeep === 'function') {
        input = Object.getPrototypeOf(input).mapDeep(input);
      } else {
        input = _.cloneDeep(input);
      }
    }

    // Remove undefined properties to avoid unwanted overwrites
    if (config.removeUndefined) {
      Object.keys(input).forEach((key) => input[key] === undefined && delete input[key]);
    }

    // Process roles
    if (config.checkRoles && input.roles && (!currentUser?.hasRole || !currentUser.hasRole(RoleEnum.ADMIN))) {
      if (!(currentUser as any)?.roles) {
        throw new UnauthorizedException('Missing roles of current user');
      } else {
        const allowedRoles = _.intersection(input.roles, (currentUser as any).roles);
        if (allowedRoles.length !== input.roles.length) {
          const missingRoles = _.difference(input.roles, (currentUser as any).roles);
          throw new UnauthorizedException('Current user not allowed setting roles: ' + missingRoles);
        }
        input.roles = allowedRoles;
      }
    }

    // Hash password
    if (input.password) {
      input.password = await bcrypt.hash((input as any).password, 10);
    }

    // Set creator
    if (config.create && currentUser) {
      input.createdBy = currentUser.id;
    }

    // Set updater
    if (currentUser) {
      input.updatedBy = currentUser.id;
    }

    // Return prepared input
    return input;
  }

  /**
   * Prepare output before return
   */
  static async prepareOutput<T = Record<string, any>>(
    output: any,
    options: { [key: string]: any; clone?: boolean; removeUndefined?: boolean; targetModel?: Partial<T> } = {}
  ) {
    // Configuration
    const config = {
      clone: false,
      removeUndefined: false,
      targetModel: undefined,
      ...options,
    };

    // Clone output
    if (config.clone) {
      if (output.cloneDeep && typeof output.cloneDeep === 'function') {
        output = Object.getPrototypeOf(output).cloneDeep(output);
      } else {
        output = _.cloneDeep(output);
      }
    }

    // Map output if target model exist
    if (config.targetModel) {
      output = (config.targetModel as any).map(output);
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
