/**
 * Type for plain inputs with only optional properties
 *
 * A primitive leaf maps to `{}`. That is how every input built on this type has always been typed, so it stays.
 */
export type PlainInput<T> = {
  // oxlint-disable-next-line typescript/no-generated-empty-object-type
  [P in keyof T]?: Partial<PlainInput<T[P]>> | Partial<T[P]>;
};
