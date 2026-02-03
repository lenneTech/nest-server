/**
 * Get type of array elements
 */
export type ArrayElement<ArrayType extends unknown | unknown[]> = ArrayType extends readonly (infer ElementType)[]
  ? ElementType
  : ArrayType;
