/**
 * Type for plain inputs with only optional properties
 */
export type PlainInput<T> = {
  [P in keyof T]?: Partial<T[P]> | Partial<PlainInput<T[P]>>;
};
