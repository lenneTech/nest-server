/**
 * Type for plain object with only properties and no methods
 * @deprecated Is deprecated, please use the type PlainObject instead
 */
export type RemoveMethods<T> = { [P in keyof T as T[P] extends (...args: any) => any ? never : P]: T[P] };
