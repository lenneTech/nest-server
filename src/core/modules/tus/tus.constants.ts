/**
 * Dependency-injection tokens of the TUS module.
 *
 * They live in a dedicated, import-free leaf file — never in `tus.module.ts` or a service — so that
 * no file needing a token has to import the module (or vice versa) and close an import cycle.
 *
 * On a cycle, a token read at MODULE-EVALUATION time — inside an `@Inject()` decorator argument, in
 * `design:paramtypes` metadata, or in a static field initializer — reads a `const` still in its
 * temporal dead zone, and SWC-compiled builds (`nest start -b swc`) die at startup with:
 *
 *   ReferenceError: Cannot access 'TUS_CONFIG' before initialization
 *
 * A file that imports nothing can never be mid-evaluation when someone imports it, in any module
 * system, under any compiler. That is the whole point — keep it import-free.
 *
 * `tsc`, `pnpm test` and `oxlint` are all blind to a regression here; only `pnpm run check:swc-tdz`
 * sees it. See .claude/rules/architecture.md → "DI Token Placement (SWC-Safe)".
 */

/**
 * Token for injecting the resolved TUS configuration.
 *
 * Injected type: `Required<ITusConfig>`.
 */
export const TUS_CONFIG = 'TUS_CONFIG';
