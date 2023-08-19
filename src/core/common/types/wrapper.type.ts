/**
 * Wrapper type used to circumvent ESM modules circular dependency issue
 * caused by reflection metadata saving the type of the property.
 *
 * It is needed if swc is used and ReferenceError occurs:
 * @Inject(forwardRef(() => CustomService)) private readonly customService: WrapperType<CustomService>,
 *
 * See https://docs.nestjs.com/recipes/swc#common-pitfalls
 */
export type WrapperType<T> = T; // WrapperType === Relation
