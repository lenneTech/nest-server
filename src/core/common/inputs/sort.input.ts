import { Field, InputType } from '@nestjs/graphql';
import { SortOrderEnum } from '../enums/sort-order.emum';
import { CoreInput } from './core-input.input';

/**
 * Sorting the returned elements
 */
@InputType({ description: 'Sorting the returned elements' })
export class SortInput extends CoreInput {
  /**
   * Field that is to be used for sorting
   */
  @Field({ description: 'Field that is to be used for sorting' })
  field: string = undefined;

  /**
   * SortInput order of the field
   */
  @Field(type => SortOrderEnum, { description: 'SortInput order of the field' })
  order: SortOrderEnum = undefined;
}
