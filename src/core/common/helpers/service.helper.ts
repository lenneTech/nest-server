import { GraphQLResolveInfo } from 'graphql';
import { GraphQLHelper } from './graphql.helper';
import { InputHelper } from './input.helper';
import * as bcrypt from 'bcrypt';

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
      input.updatdBy = currentUser.id;
    }

    // Return prepared input
    return input;
  }

  /**
   * Prepare output before return
   */
  static async prepareOutput(output: any, editorModel: new () => any, userService: any, info?: GraphQLResolveInfo) {
    // Populate createdBy and updatedBy if necessary (and field is required)
    if (
      (output.createdBy && typeof output.createdBy === 'string') ||
      (output.updatedBy && typeof output.updatedBy === 'string')
    ) {
      const graphQLFields = GraphQLHelper.getFields(info);

      // Prepare created by (string => Editor)
      if (
        output.createdBy &&
        typeof output.createdBy === 'string' &&
        GraphQLHelper.isInFields('createdBy', graphQLFields)
      ) {
        output.createdBy = InputHelper.map(await userService.get(output.createdBy, info), editorModel);
      }

      // Prepare updated by (string => Editor)
      if (output.updatedBy && typeof output.updatedBy === 'string') {
        output.updatedBy = InputHelper.map(await userService.get(output.updatedBy, info), editorModel);
      }
    }

    // Remove password if exists
    delete output.password;

    // Return prepared user
    return output;
  }
}
