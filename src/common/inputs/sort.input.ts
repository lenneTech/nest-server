import { Field, InputType } from 'type-graphql';
import { SortOrder } from '../enums/sort-order.emum';

@InputType({description: 'Sorting the returned elements'})
export class Sort {

  @Field({description: 'Field that is to be used for sorting'})
  field: string;

  @Field(type => SortOrder, {description: 'Sort order of the field'})
  order: SortOrder;
}
