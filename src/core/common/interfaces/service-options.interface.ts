import { CollationOptions } from 'mongodb';
import { Model, PopulateOptions } from 'mongoose';
import { FieldSelection } from '../types/field-selection.type';
import { PrepareInputOptions } from './prepare-input-options.interface';
import { PrepareOutputOptions } from './prepare-output-options.interface';

/**
 * General service options
 */
export interface ServiceOptions {
  // All fields are allowed to be compatible as far as possible
  [key: string]: any;

  // Check rights for input data (see check function in InputHelper)
  // If falsy: input data will not be checked
  // If truly (default): input data will be checked
  checkRights?: boolean;

  // Collation for mongodb
  // See https://www.mongodb.com/docs/manual/reference/collation/
  collation?: CollationOptions;

  // Create mode activated (see e.g. setCreateOrUpdateUserId)
  // If falsy (default): create mode is deactivated
  // If truly: create mode is activated
  create?: boolean;

  // Current user to set ownership, check rights and other things
  currentUser?: {
    [key: string]: any;
    id: string;
    roles?: string[];
  };

  // Field selection for results (will be overwritten by populate if populate was set)
  fieldSelection?: FieldSelection;

  // Determines whether all restrictions are ignored
  force?: boolean;

  // Overwrites type of input (array items)
  inputType?: new (...params: any[]) => any;

  // Overwrites type of output (array items)
  outputType?: new (...params: any[]) => any;

  // Alias for fieldSelection (if both are set fieldSelection is overwritten by populate)
  populate?: string | PopulateOptions | (PopulateOptions | string)[];

  // Process field selection
  // If {} or not set, then the field selection runs with defaults
  // If falsy, then the field selection will not be automatically executed
  processFieldSelection?: {
    model?: new (...args: any[]) => any;
    dbModel?: Model<any>;
    // Ignore selections in fieldSelection and populate
    // If falsy (default, if not set in env.config): select and populate information in fieldSelection and populate will be respected
    // If truly: select fields will be ignored and only populate fields in fieldSelection and populate will be respected
    ignoreSelections?: boolean;
  };

  // Prepare input configuration:
  // If {} or not set, then the prepareInput function will run with defaults
  // If falsy, then the prepareInput function is not executed
  prepareInput?: PrepareInputOptions;

  // Prepare output configuration:
  // If {} or not set, then the prepareInput function will run with defaults
  // If falsy, then the prepareInput function is not executed
  prepareOutput?: PrepareOutputOptions;

  // Whether to publish action via GraphQL subscription
  pubSub?: boolean;

  // Add updateBy and/or createBy user ID into input after check
  // If falsy: input data will not be changed
  // If truly (default): updatedBy and/or createdBy (when create mode is activated) will be set if current user is available
  setCreateOrUpdateUserId?: boolean;

  // Roles (as string) to check
  roles?: string | string[];
}
