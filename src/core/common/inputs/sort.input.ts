import { Field, InputType } from 'type-graphql';
import { SortOrderEnum } from '../enums/sort-order.emum';

/**
 * Sorting the returned elements
 */
@InputType({ description: 'Sorting the returned elements' })
export class SortInput {
  /**
   * Field that is to be used for sorting
   */
  @Field({ description: 'Field that is to be used for sorting' })
  field: string;

  /**
   * SortInput order of the field
   */
  @Field(type => SortOrderEnum, { description: 'SortInput order of the field' })
  order: SortOrderEnum;
}
