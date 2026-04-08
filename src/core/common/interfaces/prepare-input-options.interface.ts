/**
 * Interface for prepare input options
 */
export interface PrepareInputOptions {
  [key: string]: any;
  checkRoles?: boolean;
  clone?: boolean;
  convertObjectIdsToString?: boolean;
  create?: boolean;
  /** @deprecated No longer used — array processing always returns a new array to prevent mutation bugs */
  getNewArray?: boolean;
  removeUndefined?: boolean;
  targetModel?: new (...args: any[]) => any;
}
