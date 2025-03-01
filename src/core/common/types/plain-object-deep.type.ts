/**
 * Type for deep plain object with only properties and no methods
 * (Replacement for RemoveMethods type)
 */
export type PlainObjectDeep<T> = {
  [P in keyof T as T[P] extends (...args: any) => any ? never : P]: T[P] extends object ? PlainObjectDeep<T[P]> : T[P];
};
