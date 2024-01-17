import { registerEnumType } from '@nestjs/graphql';

/**
 * SortInput order of items
 */
export enum SortOrderEnum {
  // Ascending sorting
  ASC = 'ASC',

  // Descending sorting
  DESC = 'DESC',
}

// Register SortOrderEnum enum in TypeGraphQL
registerEnumType(SortOrderEnum, {
  description: 'SortInput order of items',
  name: 'SortOrderEnum',
});
