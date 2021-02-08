import * as bcrypt from 'bcrypt';
import { GraphQLResolveInfo } from 'graphql';

/**
 * Helper class for services
 */
export class ServiceHelper {
  /**
   * Prepare input before save
   */
  static async prepareInput(
    input: { [key: string]: any },
    currentUser: { id: string },
    options: { [key: string]: any; create?: boolean; clone?: boolean } = {},
    ...args: any[]
  ) {
    // Configuration
    const config = {
      clone: false,
      ...options,
    };

    // Clone output
    if (config.clone) {
      input = JSON.parse(JSON.stringify(input));
    }

    // Has password
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
  static async prepareOutput(
    output: any,
    userModel: new () => any,
    userService: any,
    options: { [key: string]: any; clone?: boolean } = {},
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

    // Remove password if exists
    delete output.password;

    // Return prepared user
    return output;
  }
}
