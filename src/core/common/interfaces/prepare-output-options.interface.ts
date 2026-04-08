/**
 * Interface for prepare output options
 */
export interface PrepareOutputOptions {
  [key: string]: any;
  clone?: boolean;
  /** @deprecated No longer used — array processing always returns a new array to prevent mutation bugs */
  getNewArray?: boolean;
  removeSecrets?: boolean;
  removeUndefined?: boolean;
  targetModel?: new (...args: any[]) => any;
}
