import { registerEnumType } from 'type-graphql';

/**
 * Logical operators
 */
export enum LogicalOperatorEnum {
  AND = 'AND',
  NOR = 'NOR',
  OR = 'OR'
}

// Register LogicalOperatorEnum enum in TypeGraphQL
registerEnumType(LogicalOperatorEnum, {
  name: 'LogicalOperatorEnum',
  description: 'Logical operators to combine filters',
});
