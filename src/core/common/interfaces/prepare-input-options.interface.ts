/**
 * Interface for prepare input options
 */
export interface PrepareInputOptions {
  [key: string]: any;
  checkRoles?: boolean;
  convertObjectIdsToString?: boolean;
  create?: boolean;
  clone?: boolean;
  getNewArray?: boolean;
  removeUndefined?: boolean;
  targetModel?: new (...args: any[]) => any;
}
