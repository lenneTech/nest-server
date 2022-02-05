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
    options: { [key: string]: any; create?: boolean; clone?: boolean; removeUndefined?: boolean } = {},
    ...args: any[]
  ) {
    // Configuration
    const config = {
      checkRoles: false,
      clone: false,
      create: false,
      removeUndefined: true,
      ...options,
    };

    // Clone output
    if (config.clone) {
      if (input.map && typeof input.map === 'function') {
        input = Object.getPrototypeOf(input).map(input);
      } else {
        input = JSON.parse(JSON.stringify(input));
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
    options: { [key: string]: any; clone?: boolean; targetModel?: Partial<T> } = {},
    ...args: any[]
  ) {
    // Configuration
    const config = {
      clone: false,
      ...options,
    };

    // Clone output
    if (config.clone) {
      if (output.map && typeof output.map === 'function') {
        output = Object.getPrototypeOf(output).map(output);
      } else {
        output = JSON.parse(JSON.stringify(output));
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

    // Return prepared output
    return output;
  }
}
