import { ArrayFilterNode } from '../interfaces/scim-array-filter-node.interface.js';
import { ConditionNode } from '../interfaces/scim-condition-node.interface.js';
import { LogicalNode } from '../interfaces/scim-logical-node.interface.js';

/** Union type representing any valid SCIM node */
export type ScimNode = ArrayFilterNode | ConditionNode | LogicalNode;
