/**
 * Interface for prepare output options
 */
export interface PrepareOutputOptions {
  [key: string]: any;
  clone?: boolean;
  getNewArray?: boolean;
  removeSecrets?: boolean;
  removeUndefined?: boolean;
  targetModel?: new (...args: any[]) => any;
}
