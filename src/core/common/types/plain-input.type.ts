/**
 * Type for plain inputs with only optional properties
 */
export type PlainInput<T> = {
  [P in keyof T]?: Partial<PlainInput<T[P]>> | Partial<T[P]>;
};
