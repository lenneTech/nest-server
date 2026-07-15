/**
 * Filter inputs.
 *
 * `CombinedFilterInput` and `FilterInput` are mutually recursive: a filter may contain a combined
 * filter, and a combined filter contains a list of filters. They therefore live in ONE module, and
 * `CombinedFilterInput` is declared FIRST — that ordering is load-bearing, not cosmetic.
 *
 * They used to sit in two files that imported each other. `FilterInput` referenced
 * `CombinedFilterInput` EAGERLY — in a decorator argument (`type: CombinedFilterInput`) and in the
 * `design:type` metadata `emitDecoratorMetadata` emits for `combinedFilter?: CombinedFilterInput`.
 * Decorator arguments and that metadata are evaluated at CLASS-DEFINITION time, i.e. while the
 * module is still initializing. On a cycle that reads a class binding still in its temporal dead
 * zone, and under SWC → CommonJS it threw:
 *
 *   ReferenceError: Cannot access 'CombinedFilterInput' before initialization
 *
 * That was not hypothetical — `require('.../combined-filter.input.js')` crashed. It only stayed
 * hidden because the package barrel happens to pull `filter.input` in first via other importers
 * (`filter.args`, `filter.helper`), so entering through the barrel masked it. A deep import, a unit
 * test importing the input directly, or a reordering of `src/index.ts` would all have detonated it.
 *
 * Making the reference lazy does NOT fix it: `type: () => CombinedFilterInput` still leaves the
 * eager `design:type` metadata behind, and SWC's `typeof` guard does not protect the member
 * expression it compiles to. The only real fix is to remove the import edge — hence one module.
 *
 * Within a single module the problem disappears: `FilterInput` reads `CombinedFilterInput` at
 * definition time, and by then it is already initialized. The reverse direction is safe because
 * `CombinedFilterInput` only reaches `FilterInput` lazily (a `() => FilterInput` thunk and a method
 * body), never at definition time.
 *
 * `combined-filter.input.ts` remains as a re-export so existing deep imports keep working.
 * See .claude/rules/architecture.md → "DI Token Placement (SWC-Safe)" for the general rule.
 */
import { InputType } from '@nestjs/graphql';

import { Restricted } from '../decorators/restricted.decorator';
import { UnifiedField } from '../decorators/unified-field.decorator';
import { LogicalOperatorEnum } from '../enums/logical-operator.enum';
import { RoleEnum } from '../enums/role.enum';
import { maps } from '../helpers/model.helper';
import { CoreInput } from './core-input.input';
import { SingleFilterInput } from './single-filter.input';

/**
 * Combination of multiple filters via logical operator.
 *
 * Declared BEFORE `FilterInput` on purpose — `FilterInput` dereferences this class at
 * class-definition time, so it must already be initialized. See the module docblock.
 */
@InputType({
  description: 'Combination of multiple filters via logical operator',
})
@Restricted(RoleEnum.S_EVERYONE)
export class CombinedFilterInput extends CoreInput {
  /**
   * Logical Operator to combine filters
   */
  @UnifiedField({
    description: 'Logical Operator to combine filters',
    enum: LogicalOperatorEnum,
    roles: RoleEnum.S_EVERYONE,
  })
  logicalOperator: LogicalOperatorEnum = undefined;

  /**
   * Filters to combine via logical operator
   *
   * The `() => FilterInput` thunk is required: `FilterInput` is declared below, so an eager
   * reference here would read it before initialization.
   */
  @UnifiedField({
    description: 'Filters to combine via logical operator',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
    type: () => FilterInput,
  })
  filters: FilterInput[] = undefined;

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
    this.filters = maps(data.filters, FilterInput, options.cloneDeep);
    Object.keys(this).forEach((key) => this[key] === undefined && delete this[key]);
    return this;
  }
}

/**
 * Input for filtering. The `singleFilter` will be ignored if the `combinedFilter` is set.
 */
@InputType({
  description: 'Input for filtering. The `singleFilter` will be ignored if the `combinedFilter` is set.',
})
@Restricted(RoleEnum.S_EVERYONE)
export class FilterInput extends CoreInput {
  /**
   * Combination of multiple filters via logical operator
   */
  @UnifiedField({
    description: 'Filter for a single property',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
    type: CombinedFilterInput,
  })
  combinedFilter?: CombinedFilterInput = undefined;

  /**
   * Filter for a single property
   */
  @UnifiedField({
    description: 'Filter for a single property',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
    type: SingleFilterInput,
  })
  singleFilter?: SingleFilterInput = undefined;

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
    this.combinedFilter = data.combinedFilter ? CombinedFilterInput.map(data.combinedFilter, options) : undefined;
    this.singleFilter = data.singleFilter ? SingleFilterInput.map(data.singleFilter, options) : undefined;
    Object.keys(this).forEach((key) => this[key] === undefined && delete this[key]);
    return this;
  }
}
