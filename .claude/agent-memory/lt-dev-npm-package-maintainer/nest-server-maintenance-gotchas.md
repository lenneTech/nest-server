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
`chmod +x node_modules/@nestjs/cli/bin/nest.js` and re-run. Recurred 2026-08-19 and 2026-10-03.
Do not diagnose it as a dependency incompatibility. On 2026-10-03 the launcher's mtime PREDATED
the run's first install (an earlier install in the release work had re-linked it), and it cost
one full gate cycle — check `ls -l node_modules/@nestjs/cli/bin/nest.js` BEFORE the first gate.

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

## After a machine reboot the agent shell loses fnm + Homebrew (2026-10-01)

PATH shrinks to `/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin`: `timeout` is gone (exit 127,
"command not found: timeout") and node/pnpm come from `/usr/local/bin`. Same versions there
today (node 24.12.0, pnpm 11.13.1), but do not rely on it. Prefix commands with
`export PATH="$HOME/.local/share/fnm/node-versions/<node-version>/installation/bin:/opt/homebrew/bin:$PATH"`.
The reboot also WIPES the session scratchpad under `/private/tmp` — record checksums of
candidate files in the transcript, not only in scratch, so a resumed run can verify state.

## The agent shell is zsh: `for s in "a b" ...; do $s; done` does NOT word-split

`$s` runs as ONE command name ("command not found: pnpm install --frozen-lockfile", exit 127).
Put multi-step chains into a `#!/usr/bin/env bash` script with `bash -c "$s"` per step.
Same family (2026-10-04): `grep -r --include=*.ts ...` dies with `no matches found: --include=*.ts`
(zsh NOMATCH expands the unquoted glob), and backticks inside `-e "..."` patterns break with
`bad math expression`. For repo-wide usage scans write a small Node script that walks the tree and
regex-matches `from '<pkg>'` / `import('<pkg>')` / `require('<pkg>')` / `createRequire(...)('<pkg>')`
— it also catches lazy imports, which matter here (MCP SDK, AWS SDK, ioredis are all lazy).

## Waiting for a foreign test run: `pgrep -f vitest` matches ITS OWN wait loop (2026-10-04)

The loop's shell command line contains the word, so `until ! pgrep -f vitest` never ends. Use a
self-excluding pattern: `pgrep -f "[v]itest\.mjs"` (the regex matches `vitest.mjs`, the literal
`[v]itest` in the loop's own command line does not). A foreground `until ...; do sleep 10; done`
with a bounded iteration count works as the wait (no Monitor tool needed).

## `pnpm run check` cannot validate anything past an unfixable advisory

`scripts/check.mjs` runs the audit as step 0 and returns `fail()` on a blocking audit before
any other step starts. When an advisory cannot be fixed inside the run's constraints (2026-10-01:
nodemailer 9.1.1, fixed only in 10.x), run the `check:raw` chain minus `pnpm audit` step by step
to prove the rest is green, and report the audit separately. An `ignoreGhsas` suppression is no
way out: `check:overrides` fails it with FIX AVAILABLE as soon as any range has a patch.

## An e2e "hang" at 0% CPU after a reboot: VS Code squats loopback ports (2026-10-01)

supertest starts the app with `listen(0)`, which binds the IPv6 WILDCARD `::`, then sends to
`127.0.0.1:<port>`. macOS will hand out a port that another process holds on `127.0.0.1` ONLY
(VS Code "Code Helper" processes hold ~12 such ports in 49152-65535 after a restart), and the more
specific IPv4 bind wins: every request lands in VS Code, nothing answers, and the file grinds
through 60 s timeouts x 3 attempts per test. Looks exactly like a dependency-induced deadlock —
it cost this run two hours of suspecting nodemailer 10. Port 49515 was hit in two consecutive
runs. Diagnose: `lsof -nP -iTCP:<port> -sTCP:LISTEN` shows TWO listeners (app on `*:port`,
foreign process on `127.0.0.1:port`). Inside a stuck worker, SIGUSR1 + a CDP `Runtime.evaluate`
of `globalThis.__vitest_worker__.current` names the file/test, and `process._getActiveHandles()`
shows client sockets to the app with bytesWritten > 0 and bytesRead 0.
Workaround with no repo change: reserve every `127.0.0.1`-only ephemeral port on `::` with a tiny
`net.createServer().listen({ host: '::', port })` process for the duration of the run.
Real fix (framework, not a maintenance-run edit): let the test helper listen on `127.0.0.1`
explicitly before handing the server to supertest.

## `graceful-shutdown` "leaves the event loop as empty" flakes under extreme load

Failed 3/3 retries with `TCPSocketWrap: 6 -> 7` while the machine sat at load average ~120
(another project's nuxt build + tsc); passed 4/4 isolated minutes later and in the full run
on a quiet machine. A load artefact, not a dependency regression — rerun it in isolation
before suspecting the bumped Redis/S3 client. (That run was BEFORE the reboot, so the
port-squat above is not the explanation there.)

## Direct deps that mirror an upstream EXACT pin must stay in lockstep

`graphql-ws` (direct, for the exported test helper) must equal what `@nestjs/graphql`
exact-pins (6.2.1 in 13.4.5); bumping it alone puts two copies into every consumer tree.
Same shape: `ws` (8.21.3), `multer` (platform-express pin). After any bump, list direct deps
whose lockfile carries a second version, and dedupe stale copies with a targeted
`pnpm update --depth Infinity <pkg>` (jose, @aws-sdk/client-s3, @types/node needed it).

## `husky` is a dead devDependency (found 2026-10-03, reported, not removed)

The `prepare: husky install` script was removed on 2024-10-06 (commit 7da6f77), `core.hooksPath`
is unset, so `.husky/pre-commit` / `pre-push` never run. It is the one genuinely unused package
in the manifest (everything else on the depcheck list is a false positive, see above). Removing it
is a repo decision (drop husky + `.husky/`, or re-wire hooks), not a version change — report it
when the run's scope is "versions only".

## `pnpm dedupe` in nest-server: try it in scratch, it is cheap (2026-10-03)

`pnpm dedupe --lockfile-only --ignore-scripts` in a scratch copy (package.json + workspace +
lockfile) collapsed nine in-major duplicates (@graphql-tools/merge|schema|utils, @noble/hashes,
fs-extra, picomatch, semver, tinyglobby, type-is) with ZERO other version movement — each onto the
version a fresh resolve picks anyway. Copy the lockfile back, then `pnpm install --frozen-lockfile`.
Check who held each old copy first: `@apollo/server`'s graphql-tools chain is on the runtime path.

## supertest 7.3.1 (taken 2026-10-04) made the port reservation unnecessary — VERIFIED 2026-10-06

2026-10-06 (11.42.4 run): seven `Code Helper` listeners on `127.0.0.1` 49152-65535, gate run WITHOUT
any reservation: e2e green, whole `check` 2m26s (4981 tests). Skip the reservation step now; bring it
back only if an e2e file grinds at 0% CPU again (then diagnose with the lsof recipe above).

Original note (2026-10-04):

Its only change: "bind ephemeral server to the loopback address it connects to" — i.e. exactly the
"real fix" named in the port-squat section above, done upstream. The 2026-10-04 gate still ran WITH
the `::` reservation (not worth a second full gate to test), so this is unverified. Next run: check
`lsof` for squatters, run the gate WITHOUT reserving, and if e2e stays fast, drop the reservation step.
Note it only covers requests where supertest starts the server itself; specs that `listen(0,
'127.0.0.1')` explicitly were never affected.

## The VS Code port squat is still there after a normal start (2026-10-03)

Six `Code Helper` listeners on `127.0.0.1` in 49152-65535 without any reboot. Reserving them
pre-emptively on `::` (tiny `net.createServer().listen({host:'::',port})` script, run as a managed
background task, killed after the gate) costs nothing — do it before every full gate.

## Foreign e2e runs from other lt projects: wait them out before each gate (2026-10-07)

Two separate e2e runs of another lt project appeared during one maintenance run (load 11-17). The run governor
would only drop this repo into low-resource mode; waiting is cheaper than a contention-timeout red. A
bounded foreground wait (`until ! pgrep -f "[v]itest\.mjs" >/dev/null || [ $i -ge 32 ]; do sleep 15; …`)
took ~4 min each time — run it right before `check` AND again before `check:consumer`, since a new
foreign run can start in between. Also: grepping `check:consumer` output for "build" matches the
tarball listing (`core-ai-prompt-builder.service.*`) — those lines are `pnpm pack` contents, not a diff.

## `ansi-colors` was referenced only by a dead Jest reporter (found 2026-10-09; REMOVED the same day)

`tests/report.js` is a Jest custom reporter (`onTestResult`) from before the 11.5.0 Vitest switch; no
vitest config loads it, and it is its only importer of `ansi-colors`. Removing the devDependency changes
NOTHING in the tree (4.1.3 stays via two transitive parents) and leaves a dead `require`, so the real
cleanup is deleting `tests/report.js` together with the entry — a repo decision, same as husky was.
Decided 2026-10-09: both removed (`git rm tests/report.js`, `pnpm remove ansi-colors`). 4.1.3 stays in
the lockfile as a transitive package; do not re-add it as a direct devDependency.

## High load without any vitest: find the source before the gate (2026-10-09)

Load average hit 42 with no foreign e2e run; the spike was a foreign `pnpm install` in another repo plus
VS Code helpers. A bounded wait on `sysctl -n vm.loadavg` (1-min < 20) took ~2 min and the gate then
ran clean (3m41s). `pnpm install` "Packages: +51 -119" after a pnpm version change is relinking, not
resolution — diff the lock by name+version (scratch `lockdiff.mjs` parsing the `packages:` keys) before
reading anything into it.

Related: [[nest-server-override-status]], [[deferred-major-updates]]
