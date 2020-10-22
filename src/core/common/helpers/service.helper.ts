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
    options: { create?: boolean } = {}
  ) {
    // Has password
    if (input.password) {
      input.password = await bcrypt.hash((input as any).password, 10);
    }

    // Set creator
    if (options.create && currentUser) {
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
  static async prepareOutput(output: any, userModel: new () => any, userService: any, info?: GraphQLResolveInfo) {
    // Remove password if exists
    delete output.password;

    // Return prepared user
    return output;
  }
}
