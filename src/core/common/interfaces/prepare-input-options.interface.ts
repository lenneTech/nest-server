/**
 * Interface for prepare input options
 */
export interface PrepareInputOptions {
  [key: string]: any;
  checkRoles?: boolean;
  clone?: boolean;
  convertObjectIdsToString?: boolean;
  create?: boolean;
  getNewArray?: boolean;
  removeUndefined?: boolean;
  targetModel?: new (...args: any[]) => any;
}
