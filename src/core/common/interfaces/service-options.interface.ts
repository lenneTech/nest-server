import type { CollationOptions } from 'mongodb';
import type { Model, PopulateOptions } from 'mongoose';

import { FieldSelection } from '../types/field-selection.type.js';
import { PrepareInputOptions } from './prepare-input-options.interface.js';
import { PrepareOutputOptions } from './prepare-output-options.interface.js';

/**
 * General service options
 *
 * HINT:
 * If this interface is extended (ServiceOptions & { ... }), then only properties that are not present in
 * ServiceOptions may be added in order to avoid unwanted side effects. To ensure this (also for future changes to
 * ServiceOptions), the properties of the extension should be provided with a prefix, e.g. with an underscore
 * (ServiceOptions & {_myProperty: any}).
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

  // The id `create()` gives the new record: on a synchronized model the id a client chose offline, in the model's
  // format (refused otherwise), on any other model a 24-character hex id. Passed beside the input because an input
  // class keeps only the fields it declares: an `id` inside the input is lost the moment `inputType` maps it
  createId?: string;

  // Current user to set ownership, check rights and other things
  currentUser?: {
    [key: string]: any;
    id: string;
    roles?: string[];
  };

  // Field selection for results (will be overwritten by populate if populate was set)
  fieldSelection?: FieldSelection;

  // Conditional change of a synchronized model (`@PersistedModel({ sync })`): `update()` and `delete()` apply only
  // when the stored record still has this version, in one atomic statement, and throw a 409 (`VersionConflictError`)
  // otherwise. Refused on a model that is not synchronized
  expectedVersion?: number;

  // Determines whether all restrictions are ignored
  force?: boolean;

  // Read a synchronized model's tombstones too — its deleted records, which every other read leaves out (get, find,
  // findOne, findAndCount, distinct). Reads only: update() and delete() never touch a tombstone and answer 404 for one.
  // Applies to the main model only: a populated reference to a tombstone stays empty
  includeTombstones?: boolean;

  // Overwrites type of input (array items)
  inputType?: new (...params: any[]) => any;

  // Overwrites type of output (array items)
  outputType?: new (...params: any[]) => any;

  // Alias for fieldSelection (if both are set fieldSelection is overwritten by populate)
  populate?: (PopulateOptions | string)[] | PopulateOptions | string;

  // Process field selection
  // If {} or not set, then the field selection runs with defaults
  // If falsy, then the prepareInput function is not executed
  prepareInput?: PrepareInputOptions;

  // Prepare input configuration:
  // If {} or not set, then the prepareInput function will run with defaults
  // If falsy, then the prepareInput function is not executed
  prepareOutput?: PrepareOutputOptions;

  // Prepare output configuration:
  // If {} or not set, then the prepareInput function will run with defaults
  // If falsy, then the field selection will not be automatically executed
  processFieldSelection?: {
    dbModel?: Model<any>;
    // If truly: select fields will be ignored and only populate fields in fieldSelection and populate will be respected
    ignoreSelections?: boolean;
    // Ignore selections in fieldSelection and populate
    // If falsy (default, if not set in env.config): select and populate information in fieldSelection and populate will be respected
    model?: new (...args: any[]) => any;
  };

  // Whether to publish action via GraphQL subscription
  pubSub?: boolean;

  // Whether to return raw data without preparation via prepareInput or prepareOutput (prepareInput and prepareOutput will be ignored)
  // Compare raw functions in CrudService
  raw?: boolean;

  // Roles (as string) to check
  roles?: string | string[];

  // Select fields via mongoose select
  // See https://mongoosejs.com/docs/api.html#query_Query-select
  select?: Record<string, boolean | number | object> | string | string[];

  // Add updateBy and/or createBy user ID into input after check
  // If falsy (default): input data will not be changed
  // If truly: updatedBy and/or createdBy (when create mode is activated) will be set if current user is available
  setCreateOrUpdateUserId?: boolean;
}
