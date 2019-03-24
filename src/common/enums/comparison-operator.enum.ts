import { registerEnumType } from 'type-graphql';

/**
 * Logical operators
 */
export enum ComparisonOperatorEnum {
  EQ = 'EQ',
  GT = 'GT',
  GTE = 'GTE',
  IN = 'IN',
  LT = 'LT',
  LTE = 'LTE',
  NE = 'NE',
  NIN = 'NIN',
  REGEX = 'REGEX'
}

// Register LogicalOperatorEnum enum in TypeGraphQL
registerEnumType(ComparisonOperatorEnum, {
  name: 'ComparisonOperatorEnum',
  description: '[Comparison Operators](https://docs.mongodb.com/manual/reference/operator/query-comparison/) for filters',
});
