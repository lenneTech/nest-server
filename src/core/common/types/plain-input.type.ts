/**
 * Type for plain Inputs
 */
export type PlainInput<T> = {
  [P in keyof T]?: Partial<T[P]> | Partial<PlainInput<T[P]>>;
};
