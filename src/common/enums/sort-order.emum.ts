import { registerEnumType } from 'type-graphql';

/**
 * Sort order of items
 */
export enum SortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

// Register SortOrder enum in TypeGraphQL
registerEnumType(SortOrder, {
  name: 'SortOrder',
  description: 'Sort order of items',
});
