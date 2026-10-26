/**
 * Wrapper type used to circumvent ESM modules circular dependency issue
 * caused by reflection metadata saving the type of the property.
 *
 * `emitDecoratorMetadata` writes the declared type of a decorated property or constructor parameter into
 * `design:type` / `design:paramtypes`, and that code reads the imported class while the module is still being
 * evaluated. On an import cycle the class is not initialised yet: CommonJS reads `undefined` and carries on, an ES
 * module throws `ReferenceError: Cannot access 'X' before initialization`. A type alias is not a value, so the
 * metadata becomes `Object` and nothing is read at load time.
 *
 * Use it wherever a decorated declaration points into an import cycle, typically two models that reference each
 * other or two services injected with `forwardRef`. The decorator keeps the real type through its thunk:
 *
 * @example
 * // company.model.ts ↔ user.model.ts import each other
 * @UnifiedField({ type: () => User })
 * owner?: WrapperType<User>;
 *
 * @Inject(forwardRef(() => CustomService)) private readonly customService: WrapperType<CustomService>,
 *
 * See https://docs.nestjs.com/recipes/swc#common-pitfalls
 */
export type WrapperType<T> = T; // WrapperType === Relation
