import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Repo-wiring guards for the process diagnostics.
 *
 * These deliberately live in `tests/unit/` and NOT next to the helper in `src/core/`. Everything
 * under `src/core/` is copied verbatim into vendor-mode consumer projects, where `src/main.ts` is
 * the CONSUMER's bootstrap and `src/index.ts` has been relocated by the flatten-fix — so a spec
 * that reads those repo-root paths via `process.cwd()` fails with ENOENT in every vendored project.
 * `tests/` is never copied, which makes this the correct home for assertions about THIS repo.
 *
 * All source assertions strip comments first: `// installProcessDiagnostics();` would satisfy a
 * naive `toContain()`, so a commented-out call — the single edit these guards exist to catch —
 * would pass unnoticed.
 */

/**
 * Reads a repo file with line and block comments removed.
 *
 * @param relativePath - Path relative to the repository root
 * @returns The source with comments stripped, so an assertion cannot match commented-out code
 */
function readSourceWithoutComments(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('public export surface', () => {
  it('re-exports the diagnostics helper from the package entry point', () => {
    // Consumers import from '@lenne.tech/nest-server'. A helper missing from index.ts is
    // invisible to every project — the export is part of the contract, not an afterthought.
    // Checked statically: importing the barrel here would cold-compile the whole framework
    // graph inside the unit runner (seconds per run). That the re-export actually resolves is
    // covered by `pnpm run build` (tsc).
    const indexSource = readSourceWithoutComments('src/index.ts');
    expect(indexSource).toContain("export * from './core/common/helpers/process-diagnostics.helper'");
  });
});

describe('framework dogfooding (src/main.ts)', () => {
  it('installs the diagnostics before the server is created', () => {
    const mainSource = readSourceWithoutComments('src/main.ts');
    const installIndex = mainSource.indexOf('installProcessDiagnostics()');
    const createIndex = mainSource.indexOf('NestFactory.create');
    expect(installIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeLessThan(createIndex);
  });

  it('treats a bootstrap rejection as fatal instead of leaving a zombie process', () => {
    // A bare `bootstrap();` turns a startup failure (EADDRINUSE, DB unreachable) into a mere
    // unhandledRejection — the process stays "alive" but listens on nothing.
    const mainSource = readSourceWithoutComments('src/main.ts');
    expect(mainSource).toContain('bootstrap().catch(handleFatalBootstrapError)');
    expect(mainSource).not.toMatch(/^bootstrap\(\);\s*$/m);
  });

  it('enables shutdown hooks so SIGTERM actually terminates the container', () => {
    // Without this, the diagnostics handler is the ONLY signal listener, so it takes the
    // re-raise branch — and `process.kill(self, SIGTERM)` is a no-op at PID 1 (a PID-namespace
    // init is SIGNAL_UNKILLABLE for a default-disposition signal). The listening HTTP server
    // keeps the event loop busy, so `docker stop` waits out its grace period and SIGKILLs:
    // in-flight requests dropped, every onModuleDestroy() skipped.
    const mainSource = readSourceWithoutComments('src/main.ts');
    expect(mainSource).toContain('enableShutdownHooks()');

    const hooksIndex = mainSource.indexOf('enableShutdownHooks()');
    const listenIndex = mainSource.indexOf('server.listen(');
    expect(hooksIndex).toBeGreaterThan(-1);
    expect(listenIndex).toBeGreaterThan(-1);
    expect(hooksIndex).toBeLessThan(listenIndex);
  });
});

describe('dev runner heap configuration (nodemon.json)', () => {
  it('does NOT pin --max-old-space-size', () => {
    // Measured on a 32 GB host (Node 24): `--max-old-space-size=4096` yields a heap_size_limit of
    // 4288 MB — byte-identical to the default, i.e. a no-op. On a SMALLER host it is worse than a
    // no-op: it RAISES the ceiling above V8's own choice and pushes the process closer to the OS
    // OOM-killer, which is the undiagnosable SIGKILL this helper exists to eliminate.
    //
    // In a container the flag is actively harmful: Node sizes the default heap from the cgroup
    // limit via uv_get_constrained_memory(), but ONLY while the flag is unset. Pinning a literal
    // disables that and restores the OOM-kill. Leaving it unset is the correct configuration
    // everywhere — this guard exists so a future "make dev and prod consistent" commit does not
    // silently re-add a value that cannot help.
    const nodemon = JSON.parse(readFileSync(join(process.cwd(), 'nodemon.json'), 'utf8')) as {
      env?: Record<string, string>;
    };
    expect(nodemon.env?.NODE_OPTIONS ?? '').not.toContain('--max-old-space-size');
  });
});
