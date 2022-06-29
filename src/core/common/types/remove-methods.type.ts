/**
 * Type for plain object with only properties and no methods
 */
export type RemoveMethods<T> = { [P in keyof T as T[P] extends (...args: any) => any ? never : P]: T[P] };
