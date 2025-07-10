import { ScimNode } from "../types/scim-node.type";

/** Represents a SCIM array filter node, e.g. emails[type eq "work"] */
export interface ArrayFilterNode {
  expr: ScimNode;
  path: string;
  type: 'array';
}