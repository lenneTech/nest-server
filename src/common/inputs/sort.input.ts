import { Field, InputType } from 'type-graphql';
import { SortOrderEnum } from '../enums/sort-order.emum';

@InputType({description: 'Sorting the returned elements'})
export class SortInput {

  @Field({description: 'Field that is to be used for sorting'})
  field: string;

  @Field(type => SortOrderEnum, {description: 'SortInput order of the field'})
  order: SortOrderEnum;
}
