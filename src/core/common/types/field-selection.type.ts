import { SelectionNode } from 'graphql';
import { PopulateOptions } from 'mongoose';
import { ResolveSelector } from '../interfaces/resolve-selector.interface';

/**
 * Field selection to set fields of (populated) result
 */
export type FieldSelection =
  | string
  | PopulateOptions
  | (PopulateOptions | string)[]
  | SelectionNode[]
  | ResolveSelector;
