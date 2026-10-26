import { Comparator } from '../types/scim-comparator.type.js';

/** Represents a single SCIM condition such as userName eq "Joe" */
export interface ConditionNode {
  attributePath: string;
  comparator: Comparator;
  type: 'condition';
  value?: string;
}
