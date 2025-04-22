import { ArgsType, Field, Int } from '@nestjs/graphql';
import { IsOptional } from 'class-validator';

import { UnifiedField } from '../decorators/unified-field.decorator';
import { maps } from '../helpers/model.helper';
import { CoreInput } from '../inputs/core-input.input';
import { SortInput } from '../inputs/sort.input';

@ArgsType()
export class PaginationArgs extends CoreInput {
  /**
   * Limit for pagination
   */
  @UnifiedField({
    description: 'Limit specifies the maximum number of elements found that are to be returned',
    isOptional: true,
    type: Int,
  })
  limit?: number = undefined;

  /**
   * Alias for skip
   */
  @UnifiedField({
    description: 'Alias for skip',
    isOptional: true,
    type: Int,
  })
  offset?: number = undefined;

  /**
   * Skip for pagination
   */
  @IsOptional()
  @UnifiedField({
    description: 'Skip specifies how many found elements should be skipped on return',
    isOptional: true,
    type: Int,
  })
  skip?: number = undefined;

  /**
   * Sorting for pagination
   */
  @UnifiedField({
    description: 'Sorting the returned elements',
    isOptional: true,
    type: SortInput,
  })
  sort?: SortInput[] = undefined;

  /**
   * Alias for limit
   */
  @Field(() => Int, {
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
  override map(
    data: Partial<this> | Record<string, any>,
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      mapId?: boolean;
    } = {},
  ): this {
    super.map(data, options);
    this.sort = maps(data.sort, SortInput, options.cloneDeep);
    Object.keys(this).forEach(key => this[key] === undefined && delete this[key]);
    return this;
  }
}
