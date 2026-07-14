/**
 * Unit Tests: the better-auth DI-token contract and the leaf-module invariant that protects it.
 *
 * Two things are pinned here, and both are load-bearing for reasons that no other test covers.
 *
 * 1. THE TOKEN VALUES ARE PUBLIC API.
 *    The three tokens are plain strings exported through `src/index.ts`. NestJS matches
 *    `provide:` against `@Inject()` by string VALUE, not by binding identity — so a consumer
 *    (especially a vendor-mode project) may legitimately write `@Inject('BETTER_AUTH_INSTANCE')`
 *    as a literal. Inside this repo a value change would be invisible: `provide`, `inject`,
 *    `@Inject()` and `moduleRef.get()` all reference the same imported symbol, so renaming the
 *    value flips every side at once and DI still resolves. Every test would stay green while
 *    every literal-string consumer breaks. This spec is the only thing standing between a typo
 *    and a silent downstream outage.
 *
 * 2. THE LEAF INVARIANT IS THE FIX.
 *    `core-better-auth.constants.ts` exists to be import-free. When the tokens still lived in
 *    core-better-auth.module.ts / core-better-auth.service.ts, those two files imported each
 *    other, and `@Inject(BETTER_AUTH_INSTANCE)` — a constructor-parameter decorator, evaluated
 *    at class-definition time — read the token while the cycle was still initializing. Under
 *    SWC → CommonJS that throws:
 *
 *      ReferenceError: Cannot access 'BETTER_AUTH_INSTANCE' before initialization
 *
 *    A file with zero imports can never be mid-evaluation when someone imports it, in any module
 *    system, under any compiler. Adding a single runtime import to the constants file re-opens
 *    that door, and NOTHING else in the suite would notice: tsc compiles the cycle happily, and
 *    vitest runs SWC through Vite's module runner, whose getter-based live bindings tolerate
 *    cycles. (`pnpm run check:swc-tdz` catches the actual crash; this spec catches the structural
 *    cause, in milliseconds, with a message that says what to do about it.)
 *
 *    The same applies to `core-better-auth.registry.ts`, which lets BetterAuthRolesGuard reach
 *    BetterAuthTokenService without importing CoreBetterAuthModule. It may hold `import type`
 *    only — those are erased by both tsc and SWC and emit no `require()`.
 *
 * See .claude/rules/better-auth.md §6.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BETTER_AUTH_CONFIG,
  BETTER_AUTH_COOKIE_DOMAIN,
  BETTER_AUTH_INSTANCE,
} from '../../src/core/modules/better-auth/core-better-auth.constants';
import { CoreBetterAuthModule } from '../../src/core/modules/better-auth/core-better-auth.module';
import {
  getBetterAuthTokenService,
  resetBetterAuthRegistry,
  setBetterAuthTokenService,
} from '../../src/core/modules/better-auth/core-better-auth.registry';

const MODULE_DIR = join(__dirname, '..', '..', 'src', 'core', 'modules', 'better-auth');

/**
 * Remove comments without mangling string literals.
 *
 * A naive `//` strip would corrupt any specifier containing `//` (a URL, say), and the constants
 * file's own JSDoc contains an `@example` block with real `import` statements — which a regex over
 * the raw source would happily report as imports. Both failure modes are silent, so the scanner
 * walks the source instead of pattern-matching it.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (quote) {
      if (char === '\\') {
        out += char + (next ?? '');
        i += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      out += char;
      i += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      out += char;
      i += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}

/**
 * Module specifiers that survive compilation, i.e. that emit a `require()` and therefore create an
 * edge in the runtime import graph. `import type` / `export type` are excluded: both compilers
 * erase them entirely.
 */
function runtimeImports(fileName: string): string[] {
  const code = stripComments(readFileSync(join(MODULE_DIR, fileName), 'utf8'));
  const specifiers: string[] = [];

  // `import ... from 'x'` and `export ... from 'x'`, but not the `type` variants.
  const fromRe = /\b(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(fromRe)) {
    specifiers.push(match[1]);
  }

  // Bare side-effect imports: `import 'x'`.
  const bareRe = /\bimport\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(bareRe)) {
    specifiers.push(match[1]);
  }

  // CommonJS escape hatch.
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of code.matchAll(requireRe)) {
    specifiers.push(match[1]);
  }

  return specifiers;
}

describe('BetterAuth DI tokens', () => {
  describe('token values (public API — consumers may inject them as string literals)', () => {
    it('pins the exact token strings', () => {
      // Do NOT "fix" a failure here by updating the expectation: the value IS the contract.
      // Changing it silently breaks every consumer using @Inject('BETTER_AUTH_INSTANCE').
      expect(BETTER_AUTH_INSTANCE).toBe('BETTER_AUTH_INSTANCE');
      expect(BETTER_AUTH_CONFIG).toBe('BETTER_AUTH_CONFIG');
      expect(BETTER_AUTH_COOKIE_DOMAIN).toBe('BETTER_AUTH_COOKIE_DOMAIN');
    });

    it('keeps the tokens distinct', () => {
      const tokens = [BETTER_AUTH_INSTANCE, BETTER_AUTH_CONFIG, BETTER_AUTH_COOKIE_DOMAIN];
      expect(new Set(tokens).size).toBe(tokens.length);
    });
  });

  describe('leaf-module invariant (SWC temporal-dead-zone protection)', () => {
    it('core-better-auth.constants.ts imports nothing at all', () => {
      expect(runtimeImports('core-better-auth.constants.ts')).toEqual([]);
    });

    it('core-better-auth.registry.ts emits no runtime import (type-only imports are erased)', () => {
      expect(runtimeImports('core-better-auth.registry.ts')).toEqual([]);
    });

    it('the guard reaches the token service without importing the module', () => {
      // better-auth-roles.guard.ts must not import core-better-auth.module.ts: that edge, plus the
      // module's own import of the guard, is the cycle shape that crashes SWC as soon as either
      // side gains an evaluation-time dereference (a decorator argument, a static field
      // initializer). It reads core-better-auth.registry.ts instead.
      expect(runtimeImports('better-auth-roles.guard.ts')).not.toContain('./core-better-auth.module');
    });
  });

  describe('registry lifecycle', () => {
    beforeEach(() => {
      resetBetterAuthRegistry();
    });

    afterEach(() => {
      resetBetterAuthRegistry();
    });

    it('CoreBetterAuthModule.getTokenServiceInstance() reads the registry', () => {
      const tokenService = {} as never;
      setBetterAuthTokenService(tokenService);

      // The module's public static getter must stay a thin delegate to the registry — that is what
      // lets BetterAuthRolesGuard bypass the module entirely without changing the public API.
      expect(CoreBetterAuthModule.getTokenServiceInstance()).toBe(tokenService);
      expect(getBetterAuthTokenService()).toBe(tokenService);
    });

    it('CoreBetterAuthModule.reset() clears the token service (test-isolation leak)', () => {
      setBetterAuthTokenService({} as never);
      expect(getBetterAuthTokenService()).not.toBeNull();

      CoreBetterAuthModule.reset();

      // Before the registry extraction, reset() cleared serviceInstance and userMapperInstance but
      // NOT the token service — so a token service from a previous testing module survived into the
      // next one, and BetterAuthRolesGuard silently verified tokens against a stale instance.
      expect(getBetterAuthTokenService()).toBeNull();
      expect(CoreBetterAuthModule.getTokenServiceInstance()).toBeNull();
    });
  });
});
