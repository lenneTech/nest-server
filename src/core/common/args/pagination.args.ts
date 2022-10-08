import { ArgsType, Field, Int } from '@nestjs/graphql';
import { IsOptional } from 'class-validator';
import { maps } from '../helpers/model.helper';
import { CoreInput } from '../inputs/core-input.input';
import { SortInput } from '../inputs/sort.input';

@ArgsType()
export class PaginationArgs extends CoreInput {
  /**
   * Limit for pagination
   */
  @Field((type) => Int, {
    description: 'Limit specifies the maximum number of elements found that are to be returned',
    nullable: true,
  })
  @IsOptional()
  limit?: number = undefined;

  /**
   * Alias for skip
   */
  @Field((type) => Int, {
    description: 'Alias for skip',
    nullable: true,
  })
  @IsOptional()
  offset?: number = undefined;

  /**
   * Skip for pagination
   */
  @Field((type) => Int, {
    description: 'Skip specifies how many found elements should be skipped on return',
    nullable: true,
  })
  @IsOptional()
  skip?: number = undefined;

  /**
   * Sorting for pagination
   */
  @Field((type) => [SortInput], {
    description: 'Sorting the returned elements',
    nullable: true,
  })
  @IsOptional()
  sort?: SortInput[] = undefined;

  /**
   * Alias for limit
   */
  @Field((type) => Int, {
    description: 'Alias for limit',
    nullable: true,
  })
  @IsOptional()
  take?: number = undefined;

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Mapping for Subtypes
   */
  map(
    data: Partial<this> | Record<string, any>,
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      mapId?: boolean;
    } = {}
  ): this {
    super.map(data, options);
    this.sort = maps(data.sort, SortInput, options.cloneDeep);
    Object.keys(this).forEach((key) => this[key] === undefined && delete this[key]);
    return this;
  }
}
