import { IsOptional, Max } from 'class-validator';
import { ArgsType, Field, Int } from '@nestjs/graphql';
import { SortInput } from '../inputs/sort.input';

@ArgsType()
export class PaginationArgs {
  /**
   * Limit for pagination
   */
  @Field((type) => Int, {
    description: 'Limit specifies the maximum number of elements found that are to be returned',
    nullable: true,
    defaultValue: 25,
  })
  @IsOptional()
  @Max(100)
  limit?: number = 25;

  /**
   * Offset for pagination
   */
  @Field((type) => Int, {
    description: 'Offset specifies how many found elements should be skipped on return',
    nullable: true,
    defaultValue: 0,
  })
  @IsOptional()
  offset?: number = 0;

  /**
   * Alias for offset
   */
  @Field((type) => Int, {
    description: 'Alias for offset',
    nullable: true,
    defaultValue: 0,
  })
  @IsOptional()
  skip?: number = 0;

  /**
   * Sorting for pagination
   */
  @Field((type) => [SortInput], {
    description: 'Sorting the returned elements',
    nullable: true,
  })
  @IsOptional()
  sort?: SortInput[];

  /**
   * Alias for limit
   */
  @Field((type) => Int, {
    description: 'Alias for limit',
    nullable: true,
    defaultValue: 25,
  })
  @IsOptional()
  @Max(100)
  take?: number = 25;
}
