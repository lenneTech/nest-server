export interface PrepareInputOptions {
  [key: string]: any;
  create?: boolean;
  clone?: boolean;
  getNewArray?: boolean;
  removeUndefined?: boolean;
  targetModel?: new (...args: any[]) => any;
}
