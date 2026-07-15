/**
 * `CombinedFilterInput` is declared in `./filter.input` — the two classes are mutually recursive
 * and must live in one module, or the cycle between them crashes SWC-compiled builds with
 * `ReferenceError: Cannot access 'CombinedFilterInput' before initialization`. See the docblock in
 * `./filter.input` for the full analysis.
 *
 * This file remains only so existing deep imports of `.../inputs/combined-filter.input` keep
 * resolving. Do NOT move the class back here.
 */
export { CombinedFilterInput } from './filter.input';
