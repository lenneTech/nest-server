import { ArgsType } from '@nestjs/graphql';
import { IsInt } from 'class-validator';

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
    type: Number,
    validator: () => [IsInt],
  })
  limit?: number = undefined;

  /**
   * Alias for skip
   */
  @UnifiedField({
    description: 'Alias for skip',
    isOptional: true,
    validator: () => [IsInt],
  })
  offset?: number = undefined;

  /**
   * Skip for pagination
   */
  @UnifiedField({
    description: 'Skip specifies how many found elements should be skipped on return',
    isOptional: true,
    validator: () => [IsInt],
  })
  skip?: number = undefined;

  /**
   * Sorting for pagination
   */
  @UnifiedField({
    description: 'Sorting the returned elements',
    isOptional: true,
    type: () => SortInput,
  })
  sort?: SortInput[] = undefined;

  /**
   * Alias for limit
   */
  @UnifiedField({
    description: 'Alias for limit',
    isOptional: true,
    validator: () => [IsInt],
  })
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
