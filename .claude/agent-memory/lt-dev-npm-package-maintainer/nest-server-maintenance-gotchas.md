---
name: nest-server-maintenance-gotchas
description: Environment traps when running package maintenance in nest-server — nest CLI exec bit, buffered pnpm output that looks hung, oxfmt drift, unreferenced packages
metadata:
  type: project
---

# nest-server maintenance gotchas

## `@nestjs/cli` loses its exec bit after a re-link

Any `pnpm install` that RE-LINKS `@nestjs/cli` can leave
`node_modules/@nestjs/cli/bin/nest.js` non-executable, so `check:swc-tdz` and `build` die
with `sh: .../.bin/nest: Permission denied` (exit 126).

**Why:** version-independent — the store dedups the byte-identical launcher, so reverting
the `@nestjs/cli` version does not help, and `pnpm rebuild` does not restore the bit.

**How to apply:** on exit 126 from any `nest` invocation, run
`chmod +x node_modules/@nestjs/cli/bin/nest.js` and re-run. Recurred 2026-08-19. Do not
diagnose it as a dependency incompatibility.

## Piped `pnpm install` output looks hung when it is not

`pnpm install 2>&1 | tail -N` can leave the wrapper process alive with an empty output
file long after the install itself completed in seconds. `ps` shows near-zero CPU and no
open sockets — exactly the signature of a genuine hang.

**Why:** the pipe buffers; output only flushes when the wrapper is torn down. On
2026-08-19 this cost ~30 minutes of "diagnosing" an install that had finished in 5.8s,
and the real result (a clean `format:check`) only appeared after the process was killed.

**How to apply:** pipe to a file and poll the file, or use `| cat`, rather than `| tail`.
Before concluding an install is stuck, check whether the work already landed
(`node -e "require('./node_modules/<pkg>/package.json').version"`).

## oxfmt bumps: check, do not assume

An older note held that oxfmt 0.59 reformatted markdown and that bumps are therefore
costly. **0.62.0 → 0.63.0 produced zero drift** (`format:check` clean on 422 files),
verified 2026-08-19 and taken. Note `pnpm run check` runs `format` in AUTO-FIX mode, so a
drifting formatter silently rewrites `src/` — always evaluate a formatter bump with
`format:check` BEFORE running the gate.

## `@vitest/ui` is the only unreferenced package

Scanned all 92 deps/devDeps 2026-08-19: everything resolves to a real use except
`@vitest/ui` (no script passes `--ui`, no config imports it). Left in place as a
developer convenience, not removed.

Frequent depcheck false positives here — all genuinely required, do not remove:
`@as-integrations/express5` (runtime `loadPackage` by `@nestjs/apollo`, optional peer +
`autoInstallPeers: false`), `@swc/cli` (needed by `nest build -b swc`, i.e. by
`check:swc-tdz`), `@nestjs/schematics` (`nest-cli.json` `collection`), `unplugin-swc` and
`vite-plugin-node` (root-level vitest/vite configs — remember to grep the repo ROOT, not
just `src/`), `tsconfig-paths` + `npm-watch` + `rimraf` (package.json scripts), `husky`
(`.husky/`), `@compodoc/compodoc` (`compodoc` binary in `docs` scripts).

Related: [[nest-server-override-status]], [[deferred-major-updates]]
