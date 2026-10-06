---
name: check-gate-coverage-blind-spots
description: What `pnpm run check` structurally CANNOT catch in nest-server — scripts/ is outside every gate, check-server-start.sh cannot detect a hung SIGTERM, and source-text toContain specs pass on commented-out code
metadata:
  type: project
---

Three blind spots in this repo's `check` pipeline that look covered but are not. Re-verify each time
(configs move), but start from these when grading "is the changed behaviour actually gated?".

**1. `scripts/*.ts` is outside EVERY gate.** Not `lint` (`oxlint … src/ tests/`), not `format:check`
(`oxfmt --check src/`), not `typecheck:tests` (`tsconfig.tests.json` include is
`["src/**/*.spec.ts", "tests/**/*.ts"]`), not `build` (`tsconfig.build.json` include is `src/**/*`).
The base `tsconfig.json` has no `include` so it *would* pick `scripts/` up — but nothing in `check`
runs `tsc -p tsconfig.json`.
**Why:** matters most when a manual/smoke script is offered as a substitute for automated coverage
(e.g. `scripts/brevo-smoke.ts` after the `@getbrevo/brevo` v3→v6 major). The fallback plan itself can
rot silently.
**How to apply:** any new `scripts/*.ts` → flag "no automated gate keeps this compiling"; the fix is
adding `scripts/**/*.ts` to a typecheck config, not writing more tests.

**2. `scripts/check-server-start.sh` proves boot, NOT shutdown.** It waits for the `Server startet at`
log then `exit 0`; `cleanup()` sends SIGTERM and escalates to SIGKILL after ~2s **without failing**.
So a process that ignores/hangs on SIGTERM still exits the check green.
**Why:** `src/main.ts` does NOT call `enableShutdownHooks()`, so anything installing its own
SIGTERM listener (e.g. `installProcessDiagnostics()`) owns the terminate disposition in production —
a broken re-raise means `docker stop` / `lt dev down` hangs to the grace timeout, invisibly.
**How to apply:** signal-handling changes need a child-process test (spawn → SIGTERM → assert
`signal === 'SIGTERM'` and the expected stderr line). A fake `EventEmitter` target has no OS signal
disposition and can only prove the *decision*, never the termination.

**3. "Dogfooding" specs that `readFileSync` + `toContain` pass on commented-out code.**
`expect(mainSource).toContain('installProcessDiagnostics()')` is satisfied by
`// installProcessDiagnostics();`. Same for export-surface checks against `src/index.ts`.
**Why:** these specs exist precisely to prevent someone disabling the wiring — the one edit they must
catch is the one they don't.
**How to apply:** require a comment-stripping step or a line-anchored regex (`/^\s*installProcessDiagnostics\(\);/m`).
Also check WHERE such a spec lives: under `src/core/**` it violates the vendor-mode self-containment
rule (it reaches `src/main.ts` / `nodemon.json` via `process.cwd()`, neither of which exists in
vendored form) — those describes belong in `tests/unit/`. See [[e2e-isolation-model]] for the
runner-routing counterpart.
Sibling shape, proven 2026-10-06 (wave 2b): `shared-registry-resolution.spec.ts` asserts
`block.indexOf('npm_config_registry') < block.indexOf("execFileSync(...")` on a marked block whose
explanatory COMMENT names `npm_config_registry` first, so it stays green with the env branch deleted
or moved after the pnpm call. Also: a byte-identity check over a marked block says nothing about the
CALL SITE outside it (`fetch(advisoryBulkUrl(...))` reverted to a hardcoded URL kept all specs green
in starter AND nest-server). Probe both when a spec guards "shared helper" text.
Closed in 926b691 (verified wave 2c): `codeOf()` strips `//` lines and the call site is pinned; the
order case now goes red with the env branch dropped, moved after pnpm, or renamed in BOTH copies
(identity stays green, so that is the probe that matters). It does NOT strip `/* */` or trailing
comments — fine for real regressions, note it if a future spec relies on it adversarially.
