import { ArrayFilterNode } from '../interfaces/scim-array-filter-node.interface';
import { ConditionNode } from '../interfaces/scim-condition-node.interface';
import { LogicalNode } from '../interfaces/scim-logical-node.interface';

/** Union type representing any valid SCIM node */
export type ScimNode = ArrayFilterNode | ConditionNode | LogicalNode;