import { ArgsType } from '@nestjs/graphql';

import { UnifiedField } from '../decorators/unified-field.decorator';
import { FilterInput } from '../inputs/filter.input';
import { PaginationArgs } from './pagination.args';

@ArgsType()
export class FilterArgs extends PaginationArgs {
  /**
   * Filtering
   */
  @UnifiedField({
    isOptional: true,
    type: FilterInput,
  })
  filter?: FilterInput = undefined;

  /**
   * Get a specific number of random samples from filter results
   */
  @UnifiedField({
    isOptional: true,
  })
  samples?: number = undefined;

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
    this.filter = data.filter ? FilterInput.map(data.filter, options) : undefined;
    Object.keys(this).forEach(key => this[key] === undefined && delete this[key]);
    return this;
  }
}
