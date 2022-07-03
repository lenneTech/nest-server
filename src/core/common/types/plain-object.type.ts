/**
 * Type for plain object with only properties and no methods
 * (Replacement for RemoveMethods type)
 */
export type PlainObject<T> = { [P in keyof T as T[P] extends (...args: any) => any ? never : P]: T[P] };
