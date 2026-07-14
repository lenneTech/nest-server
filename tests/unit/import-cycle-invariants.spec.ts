/**
 * Unit Tests: the structural invariants that keep SWC-compiled builds from crashing.
 *
 * THE BUG CLASS
 * -------------
 * An import cycle is survivable on its own. It becomes FATAL when a TDZ-subject binding
 * (`const` / `class` / `let`) that crosses the cycle is dereferenced at MODULE-EVALUATION time —
 * in a decorator argument, in `design:type` / `design:paramtypes` metadata (which
 * `emitDecoratorMetadata` emits eagerly), in a static field initializer, or in a top-level
 * statement. Under SWC → CommonJS → Node's `require()` that reads a binding still in its temporal
 * dead zone:
 *
 *   ReferenceError: Cannot access 'X' before initialization
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT REDUNDANT
 * ------------------------------------------------
 * `pnpm run check:swc-tdz` catches the CRASH. It does not catch the DISARMING of a safety
 * property. Each invariant below is currently the only thing standing between a live cycle and a
 * crash, and every one of them can be reverted by a well-meaning refactor — an "organize imports",
 * a "modernize to arrow functions", a "split this file up" — WITHOUT anything turning red:
 * the code still compiles, all tests still pass, and `check:swc-tdz` still goes green, because the
 * cycle is disarmed-but-present rather than armed. The crash only appears later, for a consumer,
 * on a compiler this repo's default build never runs.
 *
 * So these tests assert the SAFETY PROPERTY itself, not its consequence. They are deliberately
 * structural. If one fails, do not "fix" it by relaxing the assertion — read the docblock it points
 * at.
 *
 * See .claude/rules/architecture.md → "DI Token Placement (SWC-Safe)".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', 'src');

function read(...segments: string[]): string {
  return readFileSync(join(SRC, ...segments), 'utf8');
}

describe('SWC/TDZ import-cycle invariants', () => {
  describe('restricted.decorator — the leaf imports that took it off every cycle', () => {
    /**
     * `restricted.decorator` used to sit on TWO runtime cycles at once:
     *
     *   restricted.decorator → db.helper → input.helper → restricted.decorator
     *   restricted.decorator → tenant/core-tenant.helpers → config.service → input.helper
     *                        → restricted.decorator
     *
     * `input.helper` therefore evaluated while `restricted.decorator` was mid-initialization, and
     * only the fact that every cross-cycle dereference happened to sit inside a function body kept
     * it from throwing. One top-level line in `input.helper` — a module-level alias of
     * `checkRestricted`, an `@Restricted`-decorated class, `design:type` metadata — would have
     * crashed SWC-compiled builds, in the file that drives field-level access control.
     *
     * Both cycles are gone now, and these two imports are why:
     *   - the ID helpers moved to the `id.helper` leaf (kills the db.helper edge)
     *   - `clone` / `deepFreeze` moved to the `clone.helper` leaf (kills the config.service edge)
     *
     * Point either import back at the fat helper and the cycle returns instantly — with nothing
     * turning red, because the cycle would be present-but-disarmed again. That is what these tests
     * are for.
     */
    const restricted = read('core', 'common', 'decorators', 'restricted.decorator.ts');
    const configService = read('core', 'common', 'services', 'config.service.ts');

    it('restricted.decorator takes the ID helpers from the id.helper leaf, not db.helper', () => {
      expect(restricted).toMatch(/from '\.\.\/helpers\/id\.helper'/);
      expect(restricted).not.toMatch(/from '\.\.\/helpers\/db\.helper'/);
    });

    it('config.service takes clone/deepFreeze from the clone.helper leaf, not input.helper', () => {
      expect(configService).toMatch(/from '\.\.\/helpers\/clone\.helper'/);
      expect(configService).not.toMatch(/from '\.\.\/helpers\/input\.helper'/);
    });

    /**
     * Defense in depth. With both cycles removed, a `const` arrow here would no longer be reachable
     * from a mid-evaluation module — but `restricted.decorator` is imported by half the framework
     * and a new cycle through it is exactly the kind of thing that reappears. Hoisted function
     * declarations are initialized before any module body runs, so they stay TDZ-immune whatever the
     * import graph does next. It costs nothing to keep.
     */
    it.each(['Restricted', 'getRestricted', 'checkRestricted'])(
      '%s is a hoisted function declaration, not a const arrow (TDZ-immunity)',
      (name) => {
        expect(restricted).toMatch(new RegExp(`^export function ${name}\\b`, 'm'));
        expect(restricted).not.toMatch(new RegExp(`^export const ${name}\\s*=`, 'm'));
      },
    );
  });

  describe('the helper leaves must stay leaves', () => {
    /**
     * `id.helper` and `clone.helper` exist for exactly one reason: to be importable from files that
     * must not reach `db.helper` / `input.helper`. The moment either grows a framework import, it
     * stops being a leaf, and the cycles it was carved out to break come straight back.
     *
     * Node built-ins, lodash, rfdc, mongoose `Types` and type-only imports are fine — none of them
     * can reach back into this codebase.
     */
    const ALLOWED = /^(node:)?(inspector|util|lodash|rfdc|mongoose)$/;

    it.each([
      ['id.helper.ts', ['../types/ids.type']],
      ['clone.helper.ts', []],
    ])('%s imports no framework code', (file, allowedRelative) => {
      const source = read('core', 'common', 'helpers', file);
      const specifiers = [...source.matchAll(/^import\s+(?:type\s+)?[^;]*?['"]([^'"]+)['"]/gm)].map((m) => m[1]);

      for (const specifier of specifiers) {
        const isAllowedPackage = ALLOWED.test(specifier);
        const isAllowedRelative = (allowedRelative as string[]).includes(specifier);
        expect(
          isAllowedPackage || isAllowedRelative,
          `${file} may not import "${specifier}" — it must stay a leaf`,
        ).toBe(true);
      }
    });
  });

  describe('filter inputs — mutually recursive classes must share one module', () => {
    /**
     * `FilterInput` references `CombinedFilterInput` EAGERLY: in a decorator argument
     * (`type: CombinedFilterInput`) and in the `design:type` metadata emitted for
     * `combinedFilter?: CombinedFilterInput`. Split across two files that import each other, a
     * direct `require()` of `combined-filter.input` crashed:
     *
     *   ReferenceError: Cannot access 'CombinedFilterInput' before initialization
     *
     * It stayed hidden because entering through the package barrel pulls `filter.input` in first.
     * A lazy thunk does NOT fix this — `emitDecoratorMetadata` still emits an eager `design:type`,
     * and SWC's `typeof` guard does not protect the member expression it compiles to. The only fix
     * is to remove the import edge, so both classes live in `filter.input.ts` with
     * `CombinedFilterInput` declared FIRST.
     */
    const filterInput = read('core', 'common', 'inputs', 'filter.input.ts');
    const combinedFilterInput = read('core', 'common', 'inputs', 'combined-filter.input.ts');

    it('both classes are declared in filter.input.ts', () => {
      expect(filterInput).toMatch(/^export class CombinedFilterInput\b/m);
      expect(filterInput).toMatch(/^export class FilterInput\b/m);
    });

    it('CombinedFilterInput is declared BEFORE FilterInput (FilterInput reads it at definition time)', () => {
      const combinedAt = filterInput.indexOf('export class CombinedFilterInput');
      const filterAt = filterInput.indexOf('export class FilterInput');

      expect(combinedAt).toBeGreaterThanOrEqual(0);
      expect(filterAt).toBeGreaterThanOrEqual(0);
      expect(combinedAt).toBeLessThan(filterAt);
    });

    it('filter.input.ts does not import combined-filter.input.ts (that edge was the cycle)', () => {
      expect(filterInput).not.toMatch(/from '\.\/combined-filter\.input'/);
    });

    it('combined-filter.input.ts is a re-export shim only — no class declaration', () => {
      expect(combinedFilterInput).toMatch(/export \{ CombinedFilterInput \} from '\.\/filter\.input'/);
      expect(combinedFilterInput).not.toMatch(/^export class\b/m);
    });
  });

  describe('AI services — the type-only import is load-bearing', () => {
    /**
     * `core-ai-interaction.service` ↔ `core-ai.service` is kept off a real runtime cycle by ONE
     * thing: `AiInteractionRecord` is pulled in with `import type`, which both tsc and SWC erase.
     * `core-ai.service` has a constructor `@Inject`, so `decoratorMetadata` emits `design:paramtypes`
     * at top level — an evaluation-time deref. Widen that `import type` to a value import (an IDE
     * "organize imports" or a lint autofix will do it without asking) and the cycle becomes real and
     * armed at the same instant.
     */
    it('core-ai-interaction.service.ts imports from core-ai.service with `import type`', () => {
      const source = read('core', 'modules', 'ai', 'services', 'core-ai-interaction.service.ts');
      const valueImport = /^import\s+(?!type\b)[^;]*from\s+'\.\/core-ai\.service'/m;

      expect(source).not.toMatch(valueImport);
    });
  });
});
