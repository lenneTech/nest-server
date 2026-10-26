import { SelectionNode } from 'graphql';
import { PopulateOptions } from 'mongoose';

import { ResolveSelector } from '../interfaces/resolve-selector.interface.js';

/**
 * Field selection to set fields of (populated) result
 */
export type FieldSelection =
  | (PopulateOptions | string)[]
  | PopulateOptions
  | ResolveSelector
  | SelectionNode[]
  | string;
