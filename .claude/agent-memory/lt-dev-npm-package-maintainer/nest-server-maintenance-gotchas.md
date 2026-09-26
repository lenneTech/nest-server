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

## depcheck false positives

`@vitest/ui` was the only unreferenced package on 2026-08-19; it is no longer a devDependency.
Frequent depcheck false positives here — all genuinely required, do not remove:
`@as-integrations/express5` (runtime `loadPackage` by `@nestjs/apollo`, optional peer +
`autoInstallPeers: false`), `@swc/cli` (needed by `nest build -b swc`, i.e. by
`check:swc-tdz`), `@nestjs/schematics` (`nest-cli.json` `collection`), `unplugin-swc` and
`vite-plugin-node` (root-level vitest/vite configs — remember to grep the repo ROOT, not
just `src/`), `tsconfig-paths` + `npm-watch` + `rimraf` (package.json scripts), `husky`
(`.husky/`), `@compodoc/compodoc` (`compodoc` binary in `docs` scripts).

## `pnpm ... | tail` / `| head` fakes a hang (recurred 2026-08-22)

Reconfirmed twice in one session, and it now costs a 10-minute timeout each time. A
`pnpm install ... > file 2>&1; grep ... | head` compound ALSO hangs — redirecting the
install output to a file is not enough if a LATER command in the same compound pipes to
`head`/`tail`.

**How to apply:** never pipe to `head`/`tail` in a compound with pnpm. Use `grep -c`,
`grep -m1`, or redirect and read the file in a separate call. Confirm the work landed by
checking the artifact (lockfile mtime, `package.json` contents) before diagnosing a hang.

## oxfmt 0.70.0 / oxlint 1.85.0 (2026-09-26)

Both evaluated read-only from a scratch `npm i` before bumping: oxfmt 0.70 `--check src/
scripts/` clean on 441 files, oxlint 1.85 0 diagnostics / 639 files / 113 rules (same as
1.79). The ZWSP warning below no longer appears.

## oxlint 1.79.0 warns on an INTENTIONAL zero-width space (historical)

`tests/unit/toolchain-contract.spec.ts:16` embeds U+200B in `scripts/**<ZWSP>/*.ts` inside
a JSDoc block, so the `*/` does not terminate the comment early. oxlint 1.79.0's
`no-irregular-whitespace` flags it.

**Why it is safe to ignore:** `lint` has no `--deny-warnings`, so it exits 0, and
`lint:fix` does NOT auto-remove the character (verified 2026-08-22 — the file stayed
byte-identical). Removing it would break the comment and the file.

**How to apply:** leave it. Do not "fix" it, and do not modify the test to silence it.

## `check:overrides` said "advisory service unreachable" on every CLEAN tree (found 2026-09-26, FIXED in 11.41.4)

`scripts/check-overrides.mjs` reads `NPM_ADVISORY_BULK` in its top-level probe (~line 459)
but declares that `const` ~200 lines LATER (~line 652). Top-level ESM runs in order, so the
read throws `ReferenceError: Cannot access 'NPM_ADVISORY_BULK' before initialization`, the
bare `catch` turns it into `advisoryServiceDown = true`, and the guard prints the "COULD NOT
ASK" warning and exits 0 without verifying anything — every time the audit is empty. No
fetch is ever sent (proven with a `--import` fetch spy + an instrumented scratch copy).

**Status:** fixed in 11.41.4 — both consts now sit above the probe, pinned by the "clean LIVE
audit" cases in `tests/unit/check-overrides.guard.spec.ts` (mutation
`overrides-probe-reads-undeclared-bulk-url`).

**How to apply:** if "COULD NOT ASK" appears again while `curl` to the bulk endpoint answers 200,
suspect a new top-level ordering bug before an npm outage. A real verdict is always available with
`pnpm audit --json > a.json && node scripts/check-overrides.mjs --audit-file a.json` (the probe is
skipped in file mode). A maintenance run still may not edit `scripts/` — report instead.

## `pnpm install` can hang AFTER "Done" even without a pipe (2026-09-26)

Output showed `Done in 3s`, lockfile + node_modules written, but the process sat at 0% CPU
with no children for 10+ minutes. Killing it is safe; confirm with
`pnpm install --frozen-lockfile` afterwards. Use `timeout 300 pnpm install` for installs.

## Direct deps that mirror an upstream EXACT pin must stay in lockstep

`graphql-ws` (direct, for the exported test helper) must equal what `@nestjs/graphql`
exact-pins (6.2.1 in 13.4.5); bumping it alone puts two copies into every consumer tree.
Same shape: `ws` (8.21.3), `multer` (platform-express pin). After any bump, list direct deps
whose lockfile carries a second version, and dedupe stale copies with a targeted
`pnpm update --depth Infinity <pkg>` (jose, @aws-sdk/client-s3, @types/node needed it).

Related: [[nest-server-override-status]], [[deferred-major-updates]]
