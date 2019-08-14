import { registerEnumType } from 'type-graphql';

/**
 * Logical operators
 */
export enum LogicalOperatorEnum {
  // The logical AND operator
  AND = 'AND',

  // The logical NOR operator
  NOR = 'NOR',

  // The logical OR operator
  OR = 'OR',
}

// Register LogicalOperatorEnum enum in TypeGraphQL
registerEnumType(LogicalOperatorEnum, {
  name: 'LogicalOperatorEnum',
  description: 'Logical operators to combine filters',
});
