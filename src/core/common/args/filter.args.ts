import { IsOptional } from 'class-validator';
import { ArgsType, Field } from '@nestjs/graphql';
import { FilterInput } from '../inputs/filter.input';
import { PaginationArgs } from './pagination.args';

@ArgsType()
export class FilterArgs extends PaginationArgs {
  /**
   * Filtering
   */
  @Field((type) => FilterInput, {
    description: 'Input for filtering',
    nullable: true,
  })
  @IsOptional()
  filter?: FilterInput = undefined;

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
    this.filter = data.filter ? FilterInput.map(data.filter, options) : undefined;
    Object.keys(this).forEach((key) => this[key] === undefined && delete this[key]);
    return this;
  }
}
