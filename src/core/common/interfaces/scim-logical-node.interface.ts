import { LogicalOperator } from '../types/scim-logical-operator.type.js';
import { ScimNode } from '../types/scim-node.type.js';

/** Represents a logical operator node (e.g., X and Y, A or B) */
export interface LogicalNode {
  left: ScimNode;
  operator: LogicalOperator;
  right: ScimNode;
}
