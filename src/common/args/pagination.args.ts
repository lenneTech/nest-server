import { Int, ArgsType, Field } from 'type-graphql/dist';
import { IsOptional, Max } from 'class-validator';
import { SortInput } from '../inputs/sort.input';

@ArgsType()
export class PaginationArgs {

  /**
   * Limit for pagination
   */
  @Field(type => Int, {
    description: 'Limit specifies the maximum number of elements found that are to be returned',
    nullable: true,
    defaultValue: 25,
  })
  @IsOptional()
  @Max(100)
  take?: number = 25;

  /**
   * Skip for pagination
   */
  @Field(
    type => Int, {
      description: 'Skip specifies how many found elements should be skipped on return',
      nullable: true,
      defaultValue: 0,
    })
  @IsOptional()
  skip?: number = 0;

  /**
   * Sorting for pagination
   */
  @Field(
    type => [SortInput], {
      description: 'Sorting the returned elements',
      nullable: true,
    })
  @IsOptional()
  sort?: SortInput[];
}
