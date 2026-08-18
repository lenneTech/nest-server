/**
 * Unit Tests: every name a migration guide tells consumers to import must be reachable from the
 * package root.
 *
 * WHY THIS IS NOT COVERED ELSEWHERE
 * ---------------------------------
 * Nothing in-tree imports from `src/index.ts`. Every framework module, every test and every e2e
 * spec reaches its neighbours over a RELATIVE path, so a helper can be written, wired, documented
 * under "New Exports" and shipped while `src/index.ts` never learned about it — with the full test
 * suite, the build and `check:manifest` all green. The only party that notices is a consumer
 * importing from `@lenne.tech/nest-server`, and by then it is released.
 *
 * That is exactly what happened in 11.35.0: `resolveGuardRequest`,
 * `buildRequestContextAwareExecute` / `…Subscribe`, `createRequestContextAwareExecute` /
 * `…Subscribe`, `getTenantContextResolver` and `setTenantContextResolver` were all listed in the
 * migration guide's "New Exports" block and none of them were exported.
 *
 * HOW IT WORKS
 * ------------
 * The expected names are READ FROM THE GUIDES rather than duplicated here, so the list cannot go
 * stale: whatever a guide documents as importable from the package root is what gets checked. The
 * reachability side walks the `export * from` / `export { … } from` graph out of `src/index.ts`
 * statically — no module evaluation, so the check stays free of boot side effects and cannot be
 * satisfied by a mock.
 *
 * The resolver is deliberately textual and therefore conservative: it can only under-report
 * (missing an exotic re-export form would make this test fail on a name that IS reachable), never
 * over-report. A failure means "add the export", not "relax the assertion".
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');
const GUIDES = join(ROOT, 'migration-guides');

/** The guide this suite pins. Older guides describe an API that has since moved on. */
const GUIDE = '11.34.x-to-11.35.x.md';

/** Resolve a relative module specifier to the file it names, `.ts` or `index.ts`. */
function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  return [`${base}.ts`, join(base, 'index.ts')].find(candidate => existsSync(candidate));
}

/**
 * Collect every identifier reachable from `src/index.ts` through the re-export graph.
 *
 * Follows `export * from './x'` transitively — that is how the barrel's own entries and the
 * intra-module re-exports (`file-roles.helper.ts` → `file-roles.config.ts`,
 * `restricted.decorator.ts` → `restrictions-checked.marker.ts`) are picked up.
 */
function reachableExports(): Set<string> {
  const names = new Set<string>();
  const visited = new Set<string>();

  const visit = (file: string | undefined): void => {
    if (!file || visited.has(file)) {
      return;
    }
    visited.add(file);
    const source = readFileSync(file, 'utf8');

    // export * from './x'  — follow it
    for (const match of source.matchAll(/export\s+\*\s+from\s+['"](\.[^'"]+)['"]/g)) {
      visit(resolveSpecifier(file, match[1]));
    }

    // export { a, b as c } from './x'  /  export type { T } from './x'
    for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      for (const name of splitSpecifiers(match[1])) {
        names.add(name);
      }
    }

    // export { a, b }  — a local re-export list
    for (const match of source.matchAll(/^export\s+\{([^}]*)\}\s*;/gm)) {
      for (const name of splitSpecifiers(match[1])) {
        names.add(name);
      }
    }

    // export function / const / class / interface / type / enum X
    const declaration
      = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm;
    for (const match of source.matchAll(declaration)) {
      names.add(match[1]);
    }
  };

  visit(join(SRC, 'index.ts'));
  return names;
}

/** `a, b as c, type D` → the names an importer would write. */
function splitSpecifiers(list: string): string[] {
  return list
    .split(',')
    .map(part => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim())
    .filter((name): name is string => !!name);
}

/**
 * Every name a guide's fenced block imports from `@lenne.tech/nest-server`.
 *
 * Only that exact specifier counts — a guide also shows relative-path examples and project-local
 * imports, and those say nothing about the barrel.
 */
function documentedImports(guideFile: string): string[] {
  const guide = readFileSync(join(GUIDES, guideFile), 'utf8');
  const names = new Set<string>();
  const block = /import\s+\{([^}]*)\}\s*from\s*['"]@lenne\.tech\/nest-server['"]/g;
  for (const match of guide.matchAll(block)) {
    // Strip the `// …` annotations the guides put beside each name.
    const cleaned = match[1].replace(/\/\/[^\n]*/g, '');
    for (const name of splitSpecifiers(cleaned)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

describe('public API barrel', () => {
  it('has the guide it pins', () => {
    // Guards against a rename silently turning the suite below into a no-op.
    expect(readdirSync(GUIDES)).toContain(GUIDE);
  });

  it('exports every name the migration guide tells consumers to import', () => {
    const documented = documentedImports(GUIDE);
    // A guide that documents nothing would make this pass vacuously.
    expect(documented.length).toBeGreaterThan(20);

    const reachable = reachableExports();
    const missing = documented.filter(name => !reachable.has(name));

    expect(
      missing,
      'These names are documented as importable from the package root but are not reachable from '
      + 'src/index.ts. Add the missing `export * from` line to the barrel — do not remove them from '
      + 'the guide.',
    ).toEqual([]);
  });
});
