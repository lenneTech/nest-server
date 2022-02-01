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
    input: { [key: string]: any },
    currentUser: { [key: string]: any; id: string },
    options: { [key: string]: any; create?: boolean; clone?: boolean } = {},
    ...args: any[]
  ) {
    // Configuration
    const config = {
      checkRoles: true,
      clone: false,
      create: false,
      ...options,
    };

    // Clone output
    if (config.clone) {
      input = JSON.parse(JSON.stringify(input));
    }

    // Process roles
    if (input.roles && config.checkRoles && (!currentUser?.hasRole || !currentUser.hasRole(RoleEnum.ADMIN))) {
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
    userModel: new () => any,
    userService: any,
    options: { [key: string]: any; clone?: boolean; targetModel?: Partial<T> } = {},
    ...args: any[]
  ) {
    // Configuration
    const config = {
      clone: true,
      ...options,
    };

    // Clone output
    if (config.clone) {
      output = JSON.parse(JSON.stringify(output));
    }

    // Map output if target model exist
    if (options.targetModel) {
      (options.targetModel as any).map(output);
    }

    // Remove password if exists
    delete output.password;

    // Remove verification token if exists
    delete output.verificationToken;

    // Remove password reset token if exists
    delete output.passwordResetToken;

    // Return prepared user
    return output;
  }
}
