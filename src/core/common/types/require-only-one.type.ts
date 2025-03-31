/**
 * Require only one of the optional properties
 * See https://stackoverflow.com/a/49725198
 */
export type RequireOnlyOne<T, Keys extends keyof T = keyof T> = Pick<T, Exclude<keyof T, Keys>> &
  {
  [K in Keys]-?: Partial<Record<Exclude<Keys, K>, undefined>> & Required<Pick<T, K>>;
}[Keys];
