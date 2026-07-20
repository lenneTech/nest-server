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
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', 'src');

function read(...segments: string[]): string {
  return readFileSync(join(SRC, ...segments), 'utf8');
}

/**
 * Strip comments before looking for imports.
 *
 * These leaf files document the bug they exist to prevent, so their docblocks legitimately contain
 * the words `import`, `require()` and even whole `@example` import statements. Matching the raw
 * source flags those as violations — the guard would fail on its own explanation. Only the code is
 * evidence.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
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

  describe('the backward-compat re-exports must not be "cleaned up"', () => {
    /**
     * Moving a symbol to a leaf only stays non-breaking because its old home re-exports it. This
     * package has no `exports` map and ships `src/**` as well as `dist/**`, so consumers CAN and DO
     * deep-import these files directly — `from '@lenne.tech/nest-server/dist/core/common/helpers/db.helper'`
     * resolves.
     *
     * Every one of these re-export lines therefore carries a public contract, while looking exactly
     * like dead code to anyone tidying up imports. Deleting one is a silent breaking change for every
     * deep importer, and nothing else in the suite would notice: the symbol is still exported from
     * the package root, so the barrel tests stay green.
     */
    it.each([
      ['helpers/db.helper.ts', ['equalIds', 'getIncludedIds', 'getObjectIds', 'getStringIds'], './id.helper'],
      ['helpers/input.helper.ts', ['clone', 'deepFreeze'], './clone.helper'],
    ])('%s still re-exports %j', (file, symbols, from) => {
      const source = read('core', 'common', ...file.split('/'));
      const reExport = new RegExp(`export \\{[^}]*\\} from '${from.replace('.', '\\.')}'`);
      const line = source.match(reExport)?.[0] ?? '';

      expect(line, `${file} must re-export from ${from}`).not.toBe('');
      for (const symbol of symbols as string[]) {
        expect(line, `${file} dropped the re-export of ${symbol}`).toContain(symbol);
      }
    });

    it.each([
      ['core-better-auth.module.ts', ['BETTER_AUTH_INSTANCE']],
      ['core-better-auth.service.ts', ['BETTER_AUTH_CONFIG', 'BETTER_AUTH_COOKIE_DOMAIN']],
    ])('%s still re-exports its original tokens (and only those)', (file, symbols) => {
      const source = read('core', 'modules', 'better-auth', file);
      const line = source.match(/export \{[^}]*\} from '\.\/core-better-auth\.constants'/)?.[0] ?? '';

      expect(line, `${file} must keep its compat token re-export`).not.toBe('');
      for (const symbol of symbols as string[]) {
        expect(line, `${file} dropped the re-export of ${symbol}`).toContain(symbol);
      }
      // …and only those: widening this back out gives three valid import paths per token, which is
      // precisely how the original module <-> service cycle was born.
      const exported = line.match(/\{([^}]*)\}/)?.[1].split(',').map((s) => s.trim()) ?? [];
      expect(exported.sort()).toEqual([...(symbols as string[])].sort());
    });

    it('the registry stays OUT of the better-auth barrel (setBetterAuthTokenService is not public API)', () => {
      // Exporting it would let a consumer swap or null the token service that BetterAuthRolesGuard
      // makes its authorization decisions with.
      const barrel = read('core', 'modules', 'better-auth', 'index.ts');
      expect(barrel).not.toMatch(/^export \* from '\.\/core-better-auth\.registry'/m);
    });
  });

  describe('every DI token lives in an import-free leaf', () => {
    /**
     * The rule, and the reason it is a test rather than a note: a token declared in a module or a
     * service puts an import edge between the file that DECLARES it and every file that INJECTS it.
     * `@Inject(TOKEN)` is a constructor-parameter decorator, evaluated at class-definition time — so
     * the moment such an edge closes a cycle, the token is read while still in its temporal dead
     * zone and SWC-compiled builds die at startup.
     *
     * Both of these were live violations: `TUS_CONFIG` sat in `tus.module.ts`, and 22 `AI_*` tokens
     * were spread across eleven `ai/services/*.service.ts` files. Neither had crashed — the graphs
     * happened to be acyclic — but each was one back-import from arming, and `tsc`, `pnpm test` and
     * `oxlint` are all blind to that.
     */
    const LEAVES = [
      ['modules/tus/tus.constants.ts', 'TUS_CONFIG'],
      ['modules/ai/core-ai.constants.ts', 'AI_CONNECTION_MODEL'],
      ['modules/better-auth/core-better-auth.constants.ts', 'BETTER_AUTH_INSTANCE'],
      ['modules/hub/hub.constants.ts', 'HUB_CONFIG'],
    ] as const;

    it.each(LEAVES)('%s is a true leaf and declares %s', (file, token) => {
      const source = readFileSync(join(SRC, 'core', ...file.split('/')), 'utf8');
      const body = code(source);

      expect(source).toMatch(new RegExp(`^export const ${token} = '`, 'm'));
      // Import-free: no import, no export-from, no require. Anything else and it is not a leaf.
      expect(body).not.toMatch(/^import\s/m);
      expect(body).not.toMatch(/^export .* from /m);
      expect(body).not.toMatch(/\brequire\s*\(/);
    });

    it('no DI token is declared in a *.module.ts or a *.service.ts', () => {
      // A token here re-creates the very edge the leaves exist to remove. Re-exports are fine (they
      // are the backward-compat shims) — only DECLARATIONS are the problem.
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (/\.(module|service)\.ts$/.test(entry.name)) {
            const source = readFileSync(full, 'utf8');
            // `export const SOME_TOKEN = 'string'` — the DI-token shape.
            for (const match of source.matchAll(/^export const ([A-Z][A-Z0-9_]*) = '[^']*';/gm)) {
              offenders.push(`${relative(SRC, full)} declares ${match[1]}`);
            }
          }
        }
      };
      walk(join(SRC, 'core'));

      expect(offenders, 'move these into an import-free *.constants.ts leaf').toEqual([]);
    });
  });

  describe('AI services — the interaction record no longer closes a cycle', () => {
    /**
     * `core-ai.service` imports `core-ai-interaction.service` (it needs the class), and the
     * interaction service needs the `AiInteractionRecord` type back. While that type lived in
     * `core-ai.service`, the pair was a cycle held apart by ONE keyword: the `import type`, which
     * both compilers erase. `core-ai.service` has a constructor `@Inject`, so `decoratorMetadata`
     * emits `design:paramtypes` at top level — the exact eval-time deref that turns a cycle fatal.
     * An IDE "organize imports" widening that import would have armed it silently.
     *
     * The type now lives in its own leaf, so the edge is gone rather than merely erased.
     */
    it('core-ai-interaction.service.ts does not import from core-ai.service at all', () => {
      const source = read('core', 'modules', 'ai', 'services', 'core-ai-interaction.service.ts');

      expect(source).not.toMatch(/from '\.\/core-ai\.service'/);
    });

    it('AiInteractionRecord is declared in the interfaces leaf', () => {
      const leaf = read('core', 'modules', 'ai', 'interfaces', 'ai-interaction-record.interface.ts');

      expect(leaf).toMatch(/^export interface AiInteractionRecord\b/m);
      expect(code(leaf)).not.toMatch(/^import\s/m);
    });
  });
});
