import { IsOptional, Max } from 'class-validator';
import { ArgsType, Field, Int } from '@nestjs/graphql';
import { ModelHelper } from '../helpers/model.helper';
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
    defaultValue: 25,
  })
  @IsOptional()
  @Max(100)
  limit?: number = undefined;

  /**
   * Offset for pagination
   */
  @Field((type) => Int, {
    description: 'Offset specifies how many found elements should be skipped on return',
    nullable: true,
    defaultValue: 0,
  })
  @IsOptional()
  offset?: number = undefined;

  /**
   * Alias for offset
   */
  @Field((type) => Int, {
    description: 'Alias for offset',
    nullable: true,
    defaultValue: undefined,
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
    defaultValue: 25,
  })
  @IsOptional()
  @Max(100)
  take?: number = undefined;

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Initialize instance with default values instead of undefined
   */
  init(): this {
    super.init();
    this.limit = this.limit === undefined ? 25 : this.limit;
    this.offset = this.offset === undefined ? 0 : this.offset;
    this.skip = this.skip === undefined ? 0 : this.skip;
    this.take = this.take === undefined ? 0 : this.take;
    return this;
  }

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
    super.map(data);
    this.sort = ModelHelper.maps(data.sort, SortInput, options.cloneDeep);
    Object.keys(this).forEach((key) => this[key] === undefined && delete this[key]);
    return this;
  }
}
