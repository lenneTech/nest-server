import { IsOptional } from 'class-validator';
import { ArgsType, Field } from 'type-graphql';
import { FilterInput } from '../inputs/filter.input';
import { PaginationArgs } from './pagination.args';

@ArgsType()
export class FilterArgs extends PaginationArgs {

  /**
   * Filtering
   */
  @Field(
    type => FilterInput, {
      description: 'Input for filtering',
      nullable: true,
    })
  @IsOptional()
  filter?: FilterInput;
}
