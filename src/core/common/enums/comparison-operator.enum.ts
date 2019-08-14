import { registerEnumType } from 'type-graphql';

/**
 * Logical operators
 */
export enum ComparisonOperatorEnum {
  // Equals
  EQ = 'EQ',

  // Greater than
  GT = 'GT',

  // Greater or equal than
  GTE = 'GTE',

  // Is contained in
  IN = 'IN',

  // Lower than
  LT = 'LT',

  // Lower or equal than
  LTE = 'LTE',

  // Not equal
  NE = 'NE',

  // Is not contained in
  NIN = 'NIN',

  // Corresponds to the regular expression
  REGEX = 'REGEX',
}

// Register LogicalOperatorEnum enum in TypeGraphQL
registerEnumType(ComparisonOperatorEnum, {
  name: 'ComparisonOperatorEnum',
  description:
    '[Comparison Operators](https://docs.mongodb.com/manual/reference/operator/query-comparison/) for filters',
});
