import { registerEnumType } from 'type-graphql';

/**
 * SortInput order of items
 */
export enum SortOrderEnum {
  ASC = 'ASC',
  DESC = 'DESC',
}

// Register SortOrderEnum enum in TypeGraphQL
registerEnumType(SortOrderEnum, {
  name: 'SortOrderEnum',
  description: 'SortInput order of items',
});
