// Contract: the override guard must FIRE on the shape that shipped.
//
// The defect it exists for: in `offers`, nine of twelve pnpm overrides had
// drifted below their advisory's fixed-in version — fast-uri pinned to 3.1.3
// while the fix was 3.1.6, and eight more like it. Each looked in the diff
// exactly like a security fix. Each closed nothing, for months.
//
// Every rule below is driven from BOTH sides: a negative control proving the
// guard stays quiet on the healthy shape, and a positive control proving it
// fires on the drift. A rule only ever asserted in its passing state is
// indistinguishable from a rule that is never evaluated at all.
//
// The guard is a top-level script, not a module with exports, so it is exercised
// the way it really runs: copied into a synthetic workspace and executed, with
// the exit code and the message as the contract.

/**
 * @regression   11.39.x — `targetPackage()` split override keys on `>`, which is also the
 *   version operator. `"ws@>=8.0.0 <8.21.0"` became `"=8.0.0 <8.21.0"`, so the TOO LOW and
 *   NOT MATCHING classes — the guard's whole purpose — were unreachable for every
 *   two-sided range key, i.e. 10 of this repo's 17. It printed 10 false UNUSED warnings
 *   and still closed with `ok — 17 override(s) checked ... none is failing`. The original
 *   suite used only bare and one-sided (`pkg@<X`) keys, so it was structurally incapable
 *   of going red on it.
 * @seen-failing Restore the naive split in `scripts/check-overrides.mjs` — registered as
 *   mutation `check-overrides-range-key-blind` in tests/regression-mutations.json.
 *   The workspace-yaml reader is covered by `check-overrides-ignores-workspace-yaml`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Every case spawns a real Node process. vitest's 5s default held in isolation but
// timed out under parallel load in the full suite, so the budget is stated here
// once rather than repeated on 28 cases.
vi.setConfig({ testTimeout: 30_000 });

const GUARD = join(__dirname, '..', '..', 'scripts', 'check-overrides.mjs');

const dirs: string[] = [];
afterAll(() =>
  dirs.forEach((d) => {
    // Unguarded, one EPERM/EBUSY abandons every remaining dir (`force` only
    // suppresses ENOENT).
    try {
      rmSync(d, { force: true, maxRetries: 2, recursive: true });
    } catch {
      /* a leaked tmp dir is not worth failing a green suite over */
    }
  }),
);

/** Everything a synthetic run can vary. `advisoryData: null` omits `--advisory-file` entirely. */
interface GuardRunOptions {
  advisories?: Record<string, unknown>;
  advisoryData?: null | Record<string, unknown>;
  env?: Record<string, string>;
  ignoreGhsas?: null | string[];
  lock?: null | string;
  overrides?: Record<string, string>;
  packageManager?: null | string;
  workspaceYaml?: null | string;
}

/**
 * Builds a synthetic workspace and runs the guard in it.
 *
 * @param overrides - the `pnpm.overrides` block under test
 * @param advisories - `pnpm audit --json` advisories, keyed by id
 * @param lock - pnpm-lock.yaml contents (omit to skip the unused-override scan)
 * @param env - extra environment for the run
 */
function buildWorkspace({
  advisories = {},
  advisoryData = {},
  ignoreGhsas = null,
  lock = null,
  overrides = {},
  packageManager = null,
  workspaceYaml = null,
}: GuardRunOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'overrides-guard-'));
  dirs.push(dir);

  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(GUARD, join(dir, 'scripts', 'check-overrides.mjs'));

  const pkg: Record<string, unknown> = { name: 'synthetic', version: '1.0.0' };
  const pnpmBlock: Record<string, unknown> = {};
  if (Object.keys(overrides).length > 0) {
    pnpmBlock.overrides = overrides;
  }
  if (ignoreGhsas !== null) {
    pnpmBlock.auditConfig = { ignoreGhsas };
  }
  if (Object.keys(pnpmBlock).length > 0) {
    pkg.pnpm = pnpmBlock;
  }
  if (packageManager !== null) {
    pkg.packageManager = packageManager;
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  if (workspaceYaml !== null) {
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspaceYaml);
  }
  if (lock !== null) {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), lock);
  }

  const reportPath = join(dir, 'audit.json');
  writeFileSync(reportPath, `${JSON.stringify({ advisories })}\n`);

  // Never let a unit test reach api.github.com: it would make the suite depend on
  // network and on what upstream published today. `--advisory-file` is passed
  // UNCONDITIONALLY — defaulting it to `{}` rather than omitting the flag — because
  // the omission was not noticeable at the call site: any fixture carrying an
  // `ignoreGhsas` entry made a live request, and two cases below did exactly that
  // through the shared YAML const while this very comment claimed they could not.
  // An id absent from the file reads as "unreachable" (WARN, exit unaffected), which
  // is the honest offline answer and keeps the default harmless.
  const args = [join(dir, 'scripts', 'check-overrides.mjs'), '--audit-file', reportPath];
  if (advisoryData !== null) {
    const advisoryPath = join(dir, 'advisories.json');
    writeFileSync(advisoryPath, `${JSON.stringify(advisoryData)}\n`);
    args.push('--advisory-file', advisoryPath);
  }
  // `advisoryData: null` is the ONE way to reach the real fetch path, and the only callers that
  // use it point CHECK_OVERRIDES_ADVISORY_API at a loopback server they started themselves. The
  // guard refuses any non-loopback value, so this cannot become an accidental network call.

  return { args, dir };
}

/**
 * A crash must never pass for a verdict.
 *
 * Assertions in this file match on OUTPUT, so a guard that died before running produces
 * exactly what `not.toMatch(...)` wants to see — the absence of a warning — and the test goes
 * green having verified nothing. It is not hypothetical: the same shape hit
 * check-workspace-consistency.test.mjs when a copied script could not resolve scripts/lib/,
 * and the ERR_MODULE_NOT_FOUND read as "the guard fired".
 *
 * The name list cannot enumerate every way a process dies — a RangeError, a plain
 * `throw new Error(...)`, or a failure to spawn at all (no output) slip through it. So two
 * structural checks back it up: the process must have STARTED, and it must have SAID
 * something. Applied centrally, so a rule added later inherits all three.
 */
function assertReachedAVerdict(out: string, spawnError: Error | undefined) {
  expect(out, `the guard crashed instead of reporting — this run verified nothing:\n${out}`).not.toMatch(
    /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|ReferenceError|TypeError/,
  );
  expect(spawnError, `the guard could not be spawned: ${spawnError?.message}`).toBeUndefined();
  expect(out.trim(), 'the guard produced no output at all — it cannot have reached a verdict').not.toBe('');
}

/** Builds a synthetic workspace and runs the guard in it, synchronously. */
function run(opts: GuardRunOptions = {}) {
  const { args, dir } = buildWorkspace(opts);
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
  });
  const out = `${result.stdout}${result.stderr}`;
  assertReachedAVerdict(out, result.error);
  return { ...result, dir, out };
}

/**
 * Same contract as `run()`, but spawned ASYNCHRONOUSLY.
 *
 * Needed by exactly one group: the cases that stand up a loopback Advisory API in THIS
 * process. `spawnSync` blocks the event loop for the whole child run, so the stub server
 * could never accept the connection and every request died on the guard's own 20s timeout —
 * a green-looking "unreachable API" verdict produced by the test harness rather than by the
 * behaviour under test. Anything that serves a request to its own child must not use
 * `spawnSync`.
 */
async function runAsync(opts: GuardRunOptions = {}) {
  const { args, dir } = buildWorkspace(opts);
  const child = spawn(process.execPath, args, { env: { ...process.env, ...opts.env } });
  let out = '';
  // `spawn` reports a failure to start as an `error` EVENT, not as a property the way
  // `spawnSync` does. Passing `undefined` to the verdict check would have made this path the
  // one place a failed spawn goes unnoticed — a silent hole in the guard that exists to stop
  // exactly that.
  let spawnError: Error | undefined;
  child.on('error', (err) => (spawnError = err));
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  const status = await new Promise<null | number>((resolve) => child.on('close', resolve));
  assertReachedAVerdict(out, spawnError);
  return { dir, out, status };
}

/** One advisory in npm's schema, with only the fields the guard reads. */
function advisory({ id = 1, installed = '1.0.0', module, patched, path = `root>${module}` }) {
  return {
    [id]: {
      findings: [{ paths: [path], version: installed }],
      module_name: module,
      patched_versions: patched,
      severity: 'high',
      title: `${module}: synthetic advisory`,
      vulnerable_versions: `<${patched}`,
    },
  };
}

describe('check-overrides — an override below the advisory fix', () => {
  // THE defect. fast-uri was pinned to 3.1.3 while the fix was 3.1.6: the
  // override resolved, delivered 3.1.3, and left the hole open.
  it('FIRES when the override resolves to a version the advisory still covers', () => {
    const r = run({
      advisories: advisory({ installed: '3.1.3', module: 'fast-uri', patched: '>=3.1.6' }),
      overrides: { 'fast-uri': '3.1.3' },
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/TOO LOW/);
    expect(r.out).toMatch(/fast-uri/);
    // The fix must be readable without a second lookup — that is the whole point.
    expect(r.out).toMatch(/>=3\.1\.6/);
  });

  it('stays quiet once the target is raised past the fix', () => {
    // Same override, same package — but the advisory no longer reports it, which
    // is exactly what raising the target achieves.
    const r = run({ advisories: {}, overrides: { 'fast-uri': '3.1.6' } });
    expect(r.status, `expected pass, got:\n${r.out}`).toBe(0);
    expect(r.out).not.toMatch(/TOO LOW/);
    // A guard that bailed at the "nothing declared" early exit would satisfy the two
    // assertions above without ever having looked. The marker is what separates
    // "checked and found nothing" from "never checked".
    expect(r.out, `the guard must have reported, got:\n${r.out}`).toMatch(/override\(s\) checked/);
  });
});

describe('check-overrides — an override that does not reach the path', () => {
  it('FIRES when the installed version differs from the override target', () => {
    // The override says 6.2.1, the tree resolved 6.1.0: the selector never
    // matched this path. Raising the number would change nothing.
    const r = run({
      advisories: advisory({ installed: '6.1.0', module: 'tar', patched: '>=6.2.1' }),
      overrides: { 'some-parent>tar': '6.2.1' },
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/NOT MATCHING/);
    // The remedy differs from TOO LOW, so the two must not be conflated.
    expect(r.out).toMatch(/rescope/i);
  });
});

describe('check-overrides — advisories with no published fix', () => {
  // `patched_versions: <0.0.0` is npm's spelling for "no fix exists". offers has
  // three of these (image-size twice, extract-zip). Reporting them as TOO LOW
  // would send the reader hunting for a version number that does not exist.
  it('does not fail the build, since no target could make it green', () => {
    const r = run({
      advisories: advisory({ installed: '2.0.2', module: 'image-size', patched: '<0.0.0' }),
      overrides: { 'image-size': '2.0.2' },
    });
    expect(r.status, `expected pass, got:\n${r.out}`).toBe(0);
    expect(r.out).not.toMatch(/TOO LOW/);
  });

  it('still says so, rather than passing in silence', () => {
    const r = run({
      advisories: advisory({ installed: '2.0.2', module: 'image-size', patched: '<0.0.0' }),
      overrides: { 'image-size': '2.0.2' },
    });
    expect(r.out).toMatch(/no published fix|no patched version/i);
    expect(r.out).toMatch(/image-size/);
  });
});

describe('check-overrides — advisories without an override', () => {
  it('ignores them, because `pnpm audit` already fails the chain on those', () => {
    // Repeating every plain advisory here would bury the four classes the guard
    // exists for. Silence is the correct behaviour, not an oversight.
    const r = run({
      advisories: advisory({ installed: '1.0.0', module: 'unrelated-pkg', patched: '>=2.0.0' }),
      overrides: { 'fast-uri': '3.1.6' },
    });
    expect(r.status, `expected pass, got:\n${r.out}`).toBe(0);
    expect(r.out).not.toMatch(/unrelated-pkg/);
    expect(r.out, `the guard must have reported, got:\n${r.out}`).toMatch(/override\(s\) checked/);
  });
});

describe('check-overrides — overrides for packages that left the tree', () => {
  /**
   * @regression   11.41.8 — the UNUSED search read the WHOLE lockfile, and pnpm echoes every
   *   override into the lockfile's own top-level `overrides:` block. So every override was found
   *   in its own echo and UNUSED never fired on a real lockfile; the cases below passed only
   *   because their fixtures carried no such header.
   * @seen-failing Search the whole lockfile again instead of the `packages:` part in
   *   scripts/check-overrides.mjs — registered as mutation `check-overrides-unused-reads-override-echo`
   *   in tests/regression-mutations.json.
   */
  it("reports one that only the lockfile's own overrides header still names", () => {
    // A SELECTOR key (`pkg@<x`) is what makes the echo dangerous: the header line then carries
    // `pkg@`, exactly what the "is it in the tree" search looks for. A bare key has no `@` there.
    const r = run({
      lock: "lockfileVersion: '9.0'\n\noverrides:\n  long-gone@<1.2.3: 1.2.3\n\npackages:\n  something-else@1.0.0:\n    resolution: {integrity: sha512-x}\n",
      overrides: { 'long-gone@<1.2.3': '1.2.3' },
    });
    expect(r.status, 'dead weight is a warning, not a failure').toBe(0);
    expect(r.out, `the header echo must not count as "in the tree", got:\n${r.out}`).toMatch(/not in the tree/i);
    expect(r.out).toMatch(/long-gone/);
  });

  it('paired control: stays quiet when the package IS resolved below the header', () => {
    const r = run({
      lock: "lockfileVersion: '9.0'\n\noverrides:\n  long-gone@<1.2.3: 1.2.3\n\npackages:\n  long-gone@1.2.3:\n    resolution: {integrity: sha512-x}\n",
      overrides: { 'long-gone@<1.2.3': '1.2.3' },
    });
    expect(r.out, `long-gone IS resolved, got:\n${r.out}`).not.toMatch(/not in the tree/i);
  });

  it('reports one whose package is absent from the lockfile', () => {
    const r = run({
      lock: 'packages:\n  something-else@1.0.0:\n    resolution: {integrity: sha512-x}\n',
      overrides: { 'long-gone': '1.2.3' },
    });
    expect(r.status, 'dead weight is a warning, not a failure').toBe(0);
    expect(r.out).toMatch(/UNUSED|not in the tree/i);
    expect(r.out).toMatch(/long-gone/);
  });

  it('does not mistake a prefix for a match', () => {
    // `tar` inside `tar-stream` is the trap a substring test walks into: the
    // guard would call the override live and say nothing. The lockfile here has
    // ONLY tar-stream, so `tar` must still be reported as absent.
    const r = run({
      lock: 'packages:\n  tar-stream@3.1.7:\n    resolution: {integrity: sha512-x}\n',
      overrides: { tar: '6.2.1' },
    });
    expect(r.out, `expected tar reported absent, got:\n${r.out}`).toMatch(/UNUSED|not in the tree/i);
  });

  it('recognises the package when it IS in the lockfile', () => {
    // The negative control for the rule above — without it, a guard that reports
    // every override as unused would pass both tests before this one.
    const r = run({
      lock: 'packages:\n  tar@6.2.1:\n    resolution: {integrity: sha512-x}\n',
      overrides: { tar: '6.2.1' },
    });
    // The positive marker matters as much as the absent warning: this is the one
    // assertion in the file that passes on silence, so it must also prove the
    // guard reached its verdict rather than never having spoken.
    expect(r.status, `expected a clean run, got:\n${r.out}`).toBe(0);
    expect(r.out, `the guard must have reported, got:\n${r.out}`).toMatch(/override\(s\) checked/);
    expect(r.out, `tar IS present, got:\n${r.out}`).not.toMatch(/not in the tree/i);
  });
});

describe('check-overrides — override key shapes', () => {
  // pnpm keys carry an optional version selector and an optional parent path,
  // and a scoped name already contains the `@` that separates the selector.
  // Getting this wrong makes the guard silently match nothing — the worst
  // possible failure for a security check.
  it('matches a scoped package behind a parent selector', () => {
    const r = run({
      advisories: advisory({ installed: '1.0.0', module: '@hono/node-server', patched: '>=1.2.0' }),
      overrides: { 'hono>@hono/node-server': '1.0.0' },
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/@hono\/node-server/);
  });

  it('matches a key carrying a version selector', () => {
    const r = run({
      advisories: advisory({ installed: '1.1.11', module: 'brace-expansion', patched: '>=1.1.12' }),
      overrides: { 'brace-expansion@1': '1.1.11' },
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/brace-expansion/);
  });

  it('matches a key whose selector contains ">" — the range form', () => {
    // THE form that broke this guard, found in review. `>` is BOTH the scope
    // separator (`parent>pkg`) and a version operator (`pkg@>=1.0.0`), and
    // splitting on every `>` turned "ws@>=8.0.0 <8.21.0" into "=8.0.0 <8.21.0" —
    // a package name that matches no advisory. The override was then never
    // checked at all, while the run still ended in "none is failing", exit 0.
    //
    // Not an exotic shape: 10 of nest-server's 17 overrides use it, and
    // .claude/rules/package-management.md documents it as normal practice.
    // The suite covered `parent>@scope/pkg` and `pkg@1` and missed this one,
    // which is exactly what the neighbouring comment warns about.
    const r = run({
      advisories: advisory({ installed: '8.20.0', module: 'ws', patched: '>=8.21.3' }),
      overrides: { 'ws@>=8.0.0 <8.21.0': '8.20.0' },
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/TOO LOW/);
    expect(r.out).toMatch(/\bws\b/);
  });

  it('still fires on the one-sided selector, which never broke', () => {
    // The positive control for the rule above. `pkg@<X` parsed correctly all
    // along, so a fix that only made the two-sided form pass would be
    // indistinguishable from one that broke this — same advisory, same package,
    // only the selector shape differs.
    const r = run({
      advisories: advisory({ installed: '8.20.0', module: 'ws', patched: '>=8.21.3' }),
      overrides: { 'ws@<8.21.0': '8.20.0' },
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/TOO LOW/);
  });

  it('does not report a ">="-selector override as absent from the tree', () => {
    // The visible half of the same defect: the mangled name is looked up in the
    // lockfile, never found, and reported as dead weight. Ten such warnings on
    // every run is precisely the noise that trains a reader to skip the number
    // this guard exists to make them read.
    const r = run({
      lock: 'packages:\n  ws@8.21.3:\n    resolution: {integrity: sha512-x}\n',
      overrides: { 'ws@>=8.0.0 <8.21.0': '8.21.3' },
    });
    expect(r.out, `ws IS in the lockfile, got:\n${r.out}`).not.toMatch(/not in the tree/i);
    expect(r.out, `the guard must have reported, got:\n${r.out}`).toMatch(/override\(s\) checked/);
  });
});

describe('check-overrides — suppressed advisories that got a fix', () => {
  // The blinder half of the same problem. A GHSA in `auditConfig.ignoreGhsas` is
  // REMOVED from `pnpm audit --json` entirely (advisories drops it, muted comes
  // back empty), so once listed, no audit run ever mentions it again. The entry
  // was justified the day it was written and stops being justified in silence.
  const GHSA = 'GHSA-w3rx-r6r6-pgpr';

  it('stays quiet while the advisory genuinely has no fix', () => {
    // The state offers is in: three advisories with patched_versions <0.0.0.
    // Suppressing those is legitimate, and must not cost a red build forever.
    const r = run({
      advisoryData: { [GHSA]: { first_patched_version: null, withdrawn: false } },
      ignoreGhsas: [GHSA],
    });
    expect(r.status, `expected pass, got:\n${r.out}`).toBe(0);
    expect(r.out).not.toMatch(/FIX AVAILABLE/);
    // Must still say it looked — otherwise this is indistinguishable from a run
    // that never checked the suppression at all.
    expect(r.out).toMatch(/1\/1 suppression\(s\) verified/);
  });

  it('FIRES once upstream publishes a patched version', () => {
    const r = run({
      advisoryData: { [GHSA]: { first_patched_version: '2.1.0', withdrawn: false } },
      ignoreGhsas: [GHSA],
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/FIX AVAILABLE/);
    expect(r.out).toMatch(/2\.1\.0/);
  });

  /**
   * The THIRD shape, and the one the two above used to swallow.
   *
   * "A fix exists" and "the fix is usable" are different facts. A patched major
   * can remove an export its consumer imports, or the consumer can pin the
   * vulnerable range itself — and then FIX AVAILABLE is not advice, it is a dead
   * end that leaves a real, unfixable finding with nowhere to go but a red build
   * forever, or the guard switched off for that entry.
   *
   * Measured case (lt-crm, 2026-10-06): three `simple-git` advisories, one
   * CRITICAL requiring >=4.0.1, reachable only through
   * `nuxt > @nuxt/devtools > simple-git`. simple-git 4 dropped the default export
   * @nuxt/devtools imports, so the override made `nuxt prepare` fail outright; the
   * newest devtools in the 3.x line still imports it that way, and devtools is a
   * hard dependency of nuxt, so it can be neither raised nor dropped.
   *
   * The declaration records the consumer, the version it was assessed against,
   * AND the rejected patched versions — because each of those can change without
   * anybody revisiting the entry. Three checks, one per way the reason can
   * evaporate, each pinned by its own case below and its own mutation.
   *
   * @regression   11.42.5 — the guard read "a fix exists" and "the fix is usable"
   *   as one fact, so an unfixable finding had nowhere to go but a permanently red
   *   build or a switched-off guard. The first version of this feature then went
   *   too far the other way: it watched only the declared consumer's VERSION, so a
   *   backport into a line that consumer could use, or a second package pulling
   *   the same vulnerable version, left the suppression accepted and the printed
   *   "cannot use it" false. Found in review before release.
   * @seen-failing   six mutations in scripts/check-overrides.mjs, each applied
   *   alone, run, reverted — registered in tests/regression-mutations.json as
   *   `unusable-fix-ignores-moved-consumer`, `unusable-fix-accepts-absent-consumer`,
   *   `unusable-fix-ignores-backport`, `unusable-fix-ignores-second-consumer`,
   *   `unusable-fix-skips-workspace-importer` and
   *   `unusable-fix-first-consumer-version-wins`. None of them touches the happy
   *   path, which is the point: a guard whose expiry is gone still passes its own
   *   success case. The last one is the exception that proves it from the other
   *   side — it breaks ONLY the happy path, by rejecting a declaration that is
   *   still true, and a guard that does that gets switched off.
   */
  const DEVTOOLS_LOCK = (version: string, extra = '') =>
    `lockfileVersion: '9.0'\n\npackages:\n  '@nuxt/devtools@${version}':\n    resolution: {integrity: sha512-x}\n  simple-git@3.36.0:\n    resolution: {integrity: sha512-x}\n${extra}\nsnapshots:\n\n  '@nuxt/devtools@${version}':\n    dependencies:\n      simple-git: 3.36.0\n${extra ? `\n  new-parent@1.0.0:\n    dependencies:\n      simple-git: 3.36.0\n` : ''}`;
  const DECLARE = (value: string) =>
    `auditConfig:\n  unusableFixConsumers:\n    ${GHSA}: '${value}'\n`;
  const FIXED = { affectedPackages: ['simple-git'], patchedVersions: ['4.0.1'], withdrawn: false };

  it('accepts a fixed advisory whose fix the declared consumer provably cannot use', () => {
    const r = run({
      advisoryData: { [GHSA]: FIXED },
      ignoreGhsas: [GHSA],
      lock: DEVTOOLS_LOCK('3.4.1'),
      workspaceYaml: DECLARE('@nuxt/devtools@3.4.1 cannot use 4.0.1'),
    });
    expect(r.status, `expected pass, got:\n${r.out}`).toBe(0);
    expect(r.out).not.toMatch(/FIX AVAILABLE/);
    expect(r.out).not.toMatch(/RE-TEST/);
    // Named on the green path, every run — a residual that can stop being true
    // without anything here changing must not be able to settle into silence.
    expect(r.out, `the residual must be reported, got:\n${r.out}`).toMatch(/residual/i);
    expect(r.out).toMatch(/@nuxt\/devtools@3\.4\.1/);
  });

  it('FIRES when the declared consumer has moved, and says MOVED', () => {
    // Two checks can fire here, and which one speaks matters. Since the
    // consumer-set check started comparing `name@version` rather than just the
    // name, it catches a moved consumer by itself — so this case is no longer
    // about WHETHER the guard fires. It is about the sentence it prints: "moved
    // from 3.4.1 to 3.5.0" tells the reader to re-assess against 3.5.0, while
    // "3.5.0 also pulls an affected package" describes the same package as if a
    // second consumer had appeared, and sends them looking for one.
    const r = run({
      advisoryData: { [GHSA]: FIXED },
      ignoreGhsas: [GHSA],
      lock: DEVTOOLS_LOCK('3.5.0'),
      workspaceYaml: DECLARE('@nuxt/devtools@3.4.1 cannot use 4.0.1'),
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/RE-TEST/);
    expect(r.out, `both versions belong in the message, got:\n${r.out}`).toMatch(
      /moved from 3\.4\.1 to 3\.5\.0/,
    );
  });

  it('FIRES when the declared consumer left the tree entirely', () => {
    // Then the suppression is moot rather than justified: nothing pulls the
    // vulnerable version in any more, so the finding should have disappeared.
    const r = run({
      advisoryData: { [GHSA]: FIXED },
      ignoreGhsas: [GHSA],
      lock: "lockfileVersion: '9.0'\n\npackages:\n  something-else@1.0.0:\n    resolution: {integrity: sha512-x}\n",
      workspaceYaml: DECLARE('@nuxt/devtools@3.4.1 cannot use 4.0.1'),
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/RE-TEST/);
    expect(r.out).toMatch(/moot/);
  });

  it('FIRES on a BACKPORT — a fix in a line the consumer could use', () => {
    // The case that made the first version of this feature unsafe. Upstream
    // backports the fix into 3.36.2, which @nuxt/devtools CAN take; the consumer's
    // own version never moves, so every other check stays quiet and the residual
    // message would keep claiming the fix is unusable.
    const r = run({
      advisoryData: {
        [GHSA]: { affectedPackages: ['simple-git'], patchedVersions: ['4.0.1', '3.36.2'], withdrawn: false },
      },
      ignoreGhsas: [GHSA],
      lock: DEVTOOLS_LOCK('3.4.1'),
      workspaceYaml: DECLARE('@nuxt/devtools@3.4.1 cannot use 4.0.1'),
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/RE-TEST/);
    expect(r.out, `the unassessed version must be named, got:\n${r.out}`).toMatch(/3\.36\.2/);
  });

  it('FIRES when a SECOND consumer pulls the affected package', () => {
    // `ignoreGhsas` hides the finding everywhere, so a new parent — possibly one
    // in the production closure — would otherwise be silent while the declaration
    // still argues "only this one dev-tooling consumer".
    const r = run({
      advisoryData: { [GHSA]: FIXED },
      ignoreGhsas: [GHSA],
      lock: DEVTOOLS_LOCK('3.4.1', "  new-parent@1.0.0:\n    resolution: {integrity: sha512-x}\n"),
      workspaceYaml: DECLARE('@nuxt/devtools@3.4.1 cannot use 4.0.1'),
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/RE-TEST/);
    expect(r.out, `the new parent must be named, got:\n${r.out}`).toMatch(/new-parent/);
  });

  /**
   * A lockfile in which a WORKSPACE package depends on the affected package
   * directly. `importers:` holds the repo's OWN dependencies and sits BEFORE
   * `packages:`, so a scan that starts at `snapshots:` misses exactly this shape —
   * and it is the shape in which the declaration is least defensible, because a
   * dependency the project declares itself is one the project can raise itself.
   */
  const WORKSPACE_LOCK = (importer: string) =>
    `lockfileVersion: '9.0'\n\nimporters:\n\n  ${importer}:\n    dependencies:\n      simple-git:\n        specifier: 3.36.0\n        version: 3.36.0\n\npackages:\n\n  '@nuxt/devtools@3.4.1':\n    resolution: {integrity: sha512-x}\n  simple-git@3.36.0:\n    resolution: {integrity: sha512-x}\n\nsnapshots:\n\n  '@nuxt/devtools@3.4.1':\n    dependencies:\n      simple-git: 3.36.0\n`;

  it('FIRES when the PROJECT ITSELF depends on the affected package', () => {
    // The root importer. Nothing in the snapshot graph says the repo took a
    // direct dependency on simple-git, so the declaration's "only @nuxt/devtools
    // has it" survived untouched while the package sat in the project's own
    // package.json — where a plain version bump would have closed the advisory.
    const r = run({
      advisoryData: { [GHSA]: FIXED },
      ignoreGhsas: [GHSA],
      lock: WORKSPACE_LOCK('.'),
      workspaceYaml: DECLARE('@nuxt/devtools@3.4.1 cannot use 4.0.1'),
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/RE-TEST/);
    expect(r.out, `the importer must be named, got:\n${r.out}`).toMatch(/workspace package '\.'/);
  });

  it('FIRES when a WORKSPACE PACKAGE depends on the affected package', () => {
    // Same blind spot one level down, and the common one in this monorepo: the
    // dependency belongs to projects/api rather than to the root.
    const r = run({
      advisoryData: { [GHSA]: FIXED },
      ignoreGhsas: [GHSA],
      lock: WORKSPACE_LOCK('projects/api'),
      workspaceYaml: DECLARE('@nuxt/devtools@3.4.1 cannot use 4.0.1'),
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/RE-TEST/);
    expect(r.out, `the importer path must be named, got:\n${r.out}`).toMatch(/projects\/api/);
  });

  it('FIRES when the declared consumer does not pull the affected package at all', () => {
    // A declaration naming the WRONG consumer. Every version-shaped check passes
    // — typescript@5.9.3 is in the tree at the assessed version and no fix was
    // left unassessed — so only comparing the declaration against the actual
    // edges catches it. Until that comparison existed, a plausible-looking but
    // unrelated consumer name silenced the advisory indefinitely.
    const r = run({
      advisoryData: { [GHSA]: FIXED },
      ignoreGhsas: [GHSA],
      lock: DEVTOOLS_LOCK('3.4.1').replace(
        "  simple-git@3.36.0:\n    resolution: {integrity: sha512-x}\n",
        "  simple-git@3.36.0:\n    resolution: {integrity: sha512-x}\n  typescript@5.9.3:\n    resolution: {integrity: sha512-x}\n",
      ),
      workspaceYaml: DECLARE('typescript@5.9.3 cannot use 4.0.1'),
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/RE-TEST/);
    expect(r.out, `the real parent must be named, got:\n${r.out}`).toMatch(/@nuxt\/devtools@3\.4\.1/);
  });

  /**
   * Two versions of ONE consumer, listed newest first. pnpm keeps versions side
   * by side whenever their ranges are incompatible, so this is ordinary — and
   * reading only the FIRST match for "which version is in the tree?" made the
   * verdict depend on that order. The two cases below are the same fixture read
   * from both ends: one must pass, one must fire, and neither may be decided by
   * the listing order.
   */
  const TWO_VERSIONS = (pullers: string[]) =>
    `lockfileVersion: '9.0'\n\npackages:\n\n  '@nuxt/devtools@3.9.0':\n    resolution: {integrity: sha512-x}\n  '@nuxt/devtools@3.4.1':\n    resolution: {integrity: sha512-x}\n  simple-git@3.36.0:\n    resolution: {integrity: sha512-x}\n\nsnapshots:\n\n${pullers.map((v) => `  '@nuxt/devtools@${v}':\n    dependencies:\n      simple-git: 3.36.0\n`).join('\n')}`;

  it('accepts the declaration when the consumer\'s OTHER version pulls nothing', () => {
    // 3.9.0 exists but does not touch simple-git, so the declaration about 3.4.1
    // is still exactly true. Taking the first match called this "moved from 3.4.1
    // to 3.9.0" and demanded a re-assessment of a correct entry — a guard that
    // cries wolf gets switched off, which is how the hole this feature closes
    // came about in the first place.
    const r = run({
      advisoryData: { [GHSA]: FIXED },
      ignoreGhsas: [GHSA],
      lock: TWO_VERSIONS(['3.4.1']),
      workspaceYaml: DECLARE('@nuxt/devtools@3.4.1 cannot use 4.0.1'),
    });
    expect(r.status, `expected pass, got:\n${r.out}`).toBe(0);
    expect(r.out).not.toMatch(/RE-TEST/);
    expect(r.out).toMatch(/residual/i);
  });

  it('FIRES on the unassessed version even when it is listed LAST', () => {
    // Both versions pull simple-git and the declaration covers 3.9.0, so 3.4.1 is
    // an unassessed path. The finding must name THAT, not report a move: 3.9.0 is
    // right where the declaration says it is.
    const r = run({
      advisoryData: { [GHSA]: FIXED },
      ignoreGhsas: [GHSA],
      lock: TWO_VERSIONS(['3.9.0', '3.4.1']),
      workspaceYaml: DECLARE('@nuxt/devtools@3.9.0 cannot use 4.0.1'),
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/RE-TEST/);
    expect(r.out, `the unassessed version must be named, got:\n${r.out}`).toMatch(/3\.4\.1 also pulls/);
    expect(r.out, `3.9.0 has not moved, got:\n${r.out}`).not.toMatch(/moved from/);
  });

  it('still FIRES for a fixed advisory with no declaration at all', () => {
    // The gate must not have widened: the declaration is the only way in, and
    // forgetting it is indistinguishable from not having considered the fix.
    const r = run({
      advisoryData: { [GHSA]: FIXED },
      ignoreGhsas: [GHSA],
      lock: DEVTOOLS_LOCK('3.4.1'),
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/FIX AVAILABLE/);
    // And it must point at the declaration rather than only at "take the fix",
    // which is the advice that does not apply in this shape.
    expect(r.out).toMatch(/unusableFixConsumers/);
  });

  it('IGNORES a declaration for a WITHDRAWN advisory', () => {
    // A withdrawn advisory needs no suppression at all, so "the fix is unusable"
    // is not a reason to keep one — there is nothing left to be unfixable about.
    const r = run({
      advisoryData: { [GHSA]: { patchedVersions: [], withdrawn: true } },
      ignoreGhsas: [GHSA],
      lock: DEVTOOLS_LOCK('3.4.1'),
      workspaceYaml: DECLARE('@nuxt/devtools@3.4.1 cannot use 4.0.1'),
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/WITHDRAWN/);
  });

  it('FIRES when the advisory was withdrawn', () => {
    // A withdrawn advisory has no patched version either, so keying only on
    // `first_patched_version` would keep suppressing a finding that no longer
    // exists — dead config that looks like a considered risk decision.
    const r = run({
      advisoryData: { [GHSA]: { first_patched_version: null, withdrawn: true } },
      ignoreGhsas: [GHSA],
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/WITHDRAWN/);
  });

  it('reports an unreachable lookup as unverified, not as fine', () => {
    // `null` is what the API path yields on a network error. Treating it as
    // "still no fix" would turn an outage into a silent all-clear — and these
    // advisories are invisible to pnpm audit, so nothing else would catch it.
    //
    // `CI: ''` is load-bearing, not tidiness. An unverified suppression is TOLERATED locally and
    // ESCALATED to a hard failure under `CI` — that is the guard's documented design, and the
    // dedicated cases further down pin both halves. This case is about the REPORTING, so it has to
    // fix the variable that decides the exit code; inheriting it makes the assertion mean one thing
    // on a laptop and another on a runner. It did: this test passed locally and failed the release
    // CI run for 11.40.0, the first time it ever executed on a runner.
    const r = run({
      advisoryData: { [GHSA]: null },
      env: { CI: '' },
      ignoreGhsas: [GHSA],
    });
    expect(r.status, 'an unreachable API must not fail the chain').toBe(0);
    expect(r.out).toMatch(/UNVERIFIED/);
    expect(r.out).toMatch(/0\/1 suppression/);
  });

  it('checks suppressions even when no override is declared', () => {
    // The early exit used to trigger on "no overrides" alone. A repo that only
    // suppresses would have skipped the check entirely — the exact state in
    // which nothing else is watching.
    const r = run({
      advisoryData: { [GHSA]: { first_patched_version: '2.1.0', withdrawn: false } },
      ignoreGhsas: [GHSA],
      overrides: {},
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/FIX AVAILABLE/);
  });
});

describe('check-overrides — where pnpm actually reads the settings', () => {
  // pnpm 11 stopped reading the `pnpm` field in package.json and expects
  // `overrides` / `auditConfig` in pnpm-workspace.yaml. A guard that knew only
  // package.json would report "no overrides declared" for EVERY pnpm 11
  // workspace — finding nothing and reporting it as the all-clear, which is the
  // exact failure this script exists to catch. All five lenne.tech base repos
  // are already on pnpm 11 with their overrides in the YAML, so this is the
  // normal case, not an edge one.
  const YAML = [
    'packages:',
    '  - projects/*',
    '',
    '# Security overrides',
    'overrides:',
    "  'fast-uri@<3.1.6': '3.1.6'",
    "  'brace-expansion@<1.1.18': '1.1.18'",
    '',
    'auditConfig:',
    '  ignoreGhsas:',
    '    - GHSA-w3rx-r6r6-pgpr',
    '',
  ].join('\n');

  it('reads overrides from pnpm-workspace.yaml', () => {
    const r = run({
      advisories: advisory({ installed: '3.1.6', module: 'fast-uri', patched: '>=3.1.7' }),
      workspaceYaml: YAML,
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/TOO LOW/);
    expect(r.out).toMatch(/fast-uri/);
  });

  it('reads suppressions from pnpm-workspace.yaml', () => {
    const r = run({
      advisoryData: { 'GHSA-w3rx-r6r6-pgpr': { first_patched_version: '2.1.0', withdrawn: false } },
      workspaceYaml: YAML,
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/FIX AVAILABLE/);
  });

  it('keeps the quoted key intact, selector and all', () => {
    // The YAML keys carry a version range (`fast-uri@<3.1.6`) inside quotes, so
    // both the quote stripping and the "split off the selector" step have to be
    // right — get either wrong and the guard matches no advisory at all while
    // still reporting success.
    const r = run({
      advisories: advisory({ installed: '1.1.18', module: 'brace-expansion', patched: '>=1.1.19' }),
      workspaceYaml: YAML,
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/brace-expansion@<1\.1\.18/);
  });

  it('ignores a trailing comment on a value', () => {
    const r = run({
      advisories: advisory({ installed: '3.1.6', module: 'fast-uri', patched: '>=3.1.7' }),
      workspaceYaml: "overrides:\n  'fast-uri@<3.1.6': '3.1.6'  # CVE-2025-1234\n",
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out, `the comment must not end up in the value:\n${r.out}`).toMatch(/"3\.1\.6"/);
  });

  it('FIRES when a pnpm 11 workspace still declares them in package.json', () => {
    // The silent half of the migration: moving to pnpm 11 without moving these
    // blocks fails nothing. The overrides simply stop applying while the entries
    // sit there looking as deliberate as the day they were written. For a
    // project carrying dozens of security overrides that is the whole protection
    // gone at once, announced only by a WARN line in the install output.
    const r = run({
      overrides: { 'fast-uri': '3.1.6', tar: '7.5.2' },
      packageManager: 'pnpm@11.14.0+sha512.abc',
    });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/NOT READ/);
    expect(r.out).toMatch(/2 entries/);
  });

  it('stays quiet about the same package.json block under pnpm 10', () => {
    // The negative control that keeps the rule from being "always complain":
    // under pnpm 10 the very same block is correct and load-bearing.
    const r = run({
      overrides: { 'fast-uri': '3.1.6', tar: '7.5.2' },
      packageManager: 'pnpm@10.33.1+sha512.abc',
    });
    expect(r.status, `expected pass, got:\n${r.out}`).toBe(0);
    expect(r.out).not.toMatch(/NOT READ/);
    expect(r.out, `the guard must have reported, got:\n${r.out}`).toMatch(/override\(s\) checked/);
  });
});

describe('check-overrides — a block it cannot parse must not read as all-clear', () => {
  // The block reader handles the shapes pnpm writes today, not flow style — which pnpm
  // reads perfectly well. Reformat the file and every entry becomes invisible: same
  // semantics, opposite verdict, exit 0. That is this script's own stated failure mode,
  // so the one thing it must not do is stay quiet about it.
  it('WARNS when overrides are written in flow style', () => {
    const r = run({ workspaceYaml: "overrides: { 'fast-uri@<3.1.6': '3.1.6' }\n" });
    expect(r.out).toMatch(/parsed 0 entries for overrides/);
    expect(r.out).toMatch(/UNVERIFIED/);
  });

  it('WARNS when ignoreGhsas is written in flow style', () => {
    const r = run({ workspaceYaml: 'auditConfig:\n  ignoreGhsas: [GHSA-aaaa-bbbb-cccc]\n' });
    expect(r.out).toMatch(/parsed 0 entries for auditConfig\.ignoreGhsas/);
  });

  it('stays quiet about an EXPLICITLY empty block', () => {
    // The negative control, and the reason the rule is not just "warn on zero entries".
    // `ignoreGhsas: []` is a decision with a written justification in this repo; a warning
    // on every run would be permanent noise, and a warning nobody reads is the failure
    // this guard exists to prevent, committed by the fix for it.
    const r = run({ workspaceYaml: "overrides:\n  'fast-uri@<3.1.6': '3.1.6'\n\nauditConfig:\n  ignoreGhsas: []\n" });
    expect(r.out).not.toMatch(/parsed 0 entries/);
    expect(r.out, `the guard must have reported, got:\n${r.out}`).toMatch(/override\(s\) checked/);
  });

  it('stays quiet when the file declares neither block', () => {
    const r = run({ overrides: { 'fast-uri': '3.1.6' }, workspaceYaml: 'packages:\n  - projects/*\n' });
    expect(r.out).not.toMatch(/parsed 0 entries/);
  });
});

describe('check-overrides — degraded runs', () => {
  it('warns loudly instead of passing quietly when no audit can be obtained', () => {
    // A laptop without network must not fail the chain — but a skip that reads
    // like a pass is how check-playwright-image.mjs let its pins drift eleven
    // days behind a green check. The count of UNVERIFIED overrides is the part
    // that keeps the two apart.
    const dir = mkdtempSync(join(tmpdir(), 'overrides-guard-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    copyFileSync(GUARD, join(dir, 'scripts', 'check-overrides.mjs'));
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: 's', pnpm: { overrides: { 'fast-uri': '3.1.3' } } }, null, 2)}\n`,
    );

    // No `--audit-file`, and an empty PATH so the `pnpm` lookup cannot resolve.
    //
    // NOTE what keeps this offline, because it is not the PATH: `fetch` is a Node global and
    // does not consult PATH at all. This fixture declares overrides and NO suppressions, so
    // `advisoryStatus()` is never entered. Add an `ignoreGhsas` entry here and the case starts
    // making a live request to api.github.com — pass `--advisory-file` if you ever do.
    const r = spawnSync(process.execPath, [join(dir, 'scripts', 'check-overrides.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
    });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, `a missing audit must not fail the chain, got:\n${out}`).toBe(0);
    expect(out).toMatch(/WARN/);
    expect(out).toMatch(/NONE of them were verified/);
  });

  it('fails when an explicitly requested report cannot be read', () => {
    // Asking for a specific file and not getting it is an error, not a skip:
    // the caller stated where the answer is.
    const dir = mkdtempSync(join(tmpdir(), 'overrides-guard-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    copyFileSync(GUARD, join(dir, 'scripts', 'check-overrides.mjs'));
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ pnpm: { overrides: { a: '1' } } })}\n`);

    const r = spawnSync(
      process.execPath,
      [join(dir, 'scripts', 'check-overrides.mjs'), '--audit-file', join(dir, 'nope.json')],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/cannot read audit report/i);
  });

  /**
   * @regression   11.42.6 — a captured report that records a FAILED audit (pnpm 11 writes
   *   `{"error": {"message": "fetch failed"}}` when the registry is unreachable) read as
   *   "0 advisories, none failing". `--audit-file` is the CI path, so CI printed "ok" for a run
   *   that verified nothing.
   * @seen-failing Remove the error-report check after the audit is obtained — registered as
   *   mutation `guard-audit-error-reads-as-clean` in tests/regression-mutations.json.
   */
  it('fails on a captured report that records a failed audit (the CI path)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overrides-guard-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    copyFileSync(GUARD, join(dir, 'scripts', 'check-overrides.mjs'));
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ pnpm: { overrides: { a: '1' } } })}\n`);
    const reportPath = join(dir, 'audit.json');
    writeFileSync(reportPath, `${JSON.stringify({ error: { code: 'pnpm', message: 'fetch failed' } })}\n`);

    const r = spawnSync(process.execPath, [join(dir, 'scripts', 'check-overrides.mjs'), '--audit-file', reportPath], {
      encoding: 'utf8',
    });
    const out = `${r.stdout}${r.stderr}`;
    assertReachedAVerdict(out, r.error);
    expect(out, `a failed audit must not read as checked, got:\n${out}`).not.toMatch(/ok — /);
    expect(out).toMatch(/records a failed audit, not a result \(fetch failed\)/);
    expect(r.status).toBe(1);
  });

  it('passes trivially when nothing is declared', () => {
    // The state every base repo is in today (lt-monorepo, both starters,
    // nest-server, nuxt-extensions: zero overrides). It must not cost a run.
    const r = run({ overrides: {} });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/no overrides and no suppressions declared/);
  });
});

describe('check-overrides — an unverified suppression is a skip, and CI must not read it as a pass', () => {
  const GHSA_CI = 'GHSA-w3rx-r6r6-pgpr';

  it('warns but passes locally, where a human sees the warning', () => {
    const r = run({ advisoryData: { [GHSA_CI]: null }, env: { CI: '' }, ignoreGhsas: [GHSA_CI] });
    expect(r.status, `expected pass, got:\n${r.out}`).toBe(0);
    expect(r.out).toMatch(/UNVERIFIED/);
  });

  it('FAILS under CI, where a green step is the only thing anybody reads', () => {
    // Same input, same verdict about the advisory — only the audience differs. Nobody reads
    // stderr on a green CI step, so the skip would render exactly like a check that ran.
    const r = run({ advisoryData: { [GHSA_CI]: null }, env: { CI: 'true' }, ignoreGhsas: [GHSA_CI] });
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/could not be verified/);
  });

  it('still passes under CI once the suppression IS verified', () => {
    // The negative control: the CI rule must key on "unverified", not on "CI plus a suppression".
    const r = run({
      advisoryData: { [GHSA_CI]: { first_patched_version: null, withdrawn: false } },
      env: { CI: 'true' },
      ignoreGhsas: [GHSA_CI],
    });
    expect(r.status, `expected pass, got:\n${r.out}`).toBe(0);
    expect(r.out).toMatch(/1\/1 suppression\(s\) verified/);
  });
});

describe('check-overrides — a rate limit is a quota problem, not a security finding', () => {
  // These cases exercise the ONE branch `--advisory-file` cannot reach: the real `fetch`.
  // They point CHECK_OVERRIDES_ADVISORY_API at a loopback server started here. The guard
  // refuses any non-loopback value, so the seam cannot redirect anything in CI — that
  // restriction is itself asserted below, because a test-only escape hatch in a security
  // script is worth exactly as much as the rule that keeps it test-only.
  const GHSA_RL = 'GHSA-w3rx-r6r6-pgpr';

  /** A loopback Advisory API that answers every request the same way. */
  async function withStubApi(
    respond: (res: import('node:http').ServerResponse) => void,
    body: (base: string) => { env?: Record<string, string>; ignoreGhsas?: string[] },
  ) {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => respond(res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    try {
      const opts = body(`http://127.0.0.1:${port}`);
      // ASYNC on purpose: spawnSync would block this process's event loop and the stub
      // server below could never answer its own child. See runAsync().
      return await runAsync({
        advisoryData: null,
        env: { CHECK_OVERRIDES_ADVISORY_API: `http://127.0.0.1:${port}`, ...opts.env },
        ignoreGhsas: opts.ignoreGhsas ?? [GHSA_RL],
      });
    } finally {
      // `server.close()` only stops NEW connections; it waits for existing ones, and the
      // guard's `fetch` leaves a keep-alive socket behind, so a server that only calls
      // `close()` can still hold a handle after its test has finished. Dropping the
      // connections first is what makes the close actually complete.
      //
      // HARDENING, NOT A DIAGNOSIS. These lines went in while chasing an
      // `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending` — the
      // whole suite green and the STEP red, blamed on whichever spec ran last. That
      // explanation was retracted: a bisect with these five cases EXCLUDED still produced the
      // error once in twelve runs, so it is pre-existing (~1 in 10) and this file did not
      // cause it. The handle leak is real and worth closing on its own; it is simply not the
      // proven cause of that failure. A plausible story fitted to an observation is not a
      // cause, and leaving the stronger claim here would make it look settled.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  const rateLimited = (res: import('node:http').ServerResponse) => {
    res.writeHead(403, { 'content-type': 'application/json', 'x-ratelimit-remaining': '0' });
    res.end('{"message":"API rate limit exceeded"}');
  };

  it('names the quota as the cause, locally', async () => {
    const r = await withStubApi(rateLimited, () => ({ env: { CI: '' } }));
    expect(r.status, `a rate limit must not fail a local run, got:\n${r.out}`).toBe(0);
    expect(r.out).toMatch(/UNVERIFIED/);
    expect(r.out, `the quota cause must be named, got:\n${r.out}`).toMatch(/quota is exhausted/);
    expect(r.out).toMatch(/GITHUB_TOKEN/);
  });

  it('fails under CI but says it is a quota, not a finding', async () => {
    const r = await withStubApi(rateLimited, () => ({ env: { CI: 'true' } }));
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/RATE LIMITED/);
    expect(r.out, `it must say this is not a security problem, got:\n${r.out}`).toMatch(/not a security one/);
  });

  it('does NOT claim a rate limit for an ordinary failure', async () => {
    // The negative control, and the point of the whole distinction: a 500 is also
    // "unverified", but calling it a quota would send the reader after the wrong fix.
    const r = await withStubApi(
      (res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"message":"boom"}');
      },
      () => ({ env: { CI: 'true' } }),
    );
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/could not be verified/);
    expect(r.out, `a 500 is not a quota, got:\n${r.out}`).not.toMatch(/RATE LIMITED|quota is exhausted/);
  });

  it('really talks to the stub, so the cases above are not vacuous', async () => {
    // Without this, a guard that never reached the network at all would satisfy every
    // assertion above — they all key on the absence or presence of a WARNING.
    const r = await withStubApi(
      (res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ vulnerabilities: [{ first_patched_version: '2.1.0' }] }));
      },
      () => ({}),
    );
    expect(r.status, `expected failure, got:\n${r.out}`).toBe(1);
    expect(r.out, `the stub's answer must reach the verdict, got:\n${r.out}`).toMatch(/FIX AVAILABLE/);
    expect(r.out).toMatch(/2\.1\.0/);
  });

  it('refuses a non-loopback override, which is what makes the seam safe', async () => {
    // The security property. Without it this env var would be a redirect switch for a
    // security check: anything able to set the environment could point the suppression
    // lookup at a server that answers "no fix exists" forever.
    const r = run({
      env: { CHECK_OVERRIDES_ADVISORY_API: 'https://evil.example.com' },
      overrides: { 'fast-uri': '3.1.6' },
    });
    expect(r.out).toMatch(/ignoring CHECK_OVERRIDES_ADVISORY_API/);
    expect(r.out).toMatch(/only a loopback address/);
    expect(r.status, `a rejected override must not fail the run, got:\n${r.out}`).toBe(0);
  });
});

describe('check-overrides — a clean LIVE audit is probed, not assumed', () => {
  // The one path `--audit-file` cannot reach: a live `pnpm audit` that comes back clean, after
  // which the guard asks npm's bulk endpoint whether "0 advisories" meant "nothing found" or
  // "could not ask". A fake `pnpm` on PATH supplies the clean report, and a loopback server
  // stands in for the endpoint, so the case stays offline and deterministic.
  async function runLiveClean(
    status: number,
    opts: {
      advisoryData?: Record<string, unknown>;
      auditExit?: number;
      auditReport?: string;
      ignoreGhsas?: string[];
      registry?: string;
      registryEnv?: 'npm_config_registry' | 'pnpm_config_registry';
      useApiOverride?: boolean;
    } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'overrides-guard-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    copyFileSync(GUARD, join(dir, 'scripts', 'check-overrides.mjs'));
    const pnpmBlock: Record<string, unknown> = { overrides: { 'fast-uri': '3.1.3' } };
    if (opts.ignoreGhsas) {
      pnpmBlock.auditConfig = { ignoreGhsas: opts.ignoreGhsas };
    }
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 's', pnpm: pnpmBlock }, null, 2)}\n`);
    // Suppressions are verified against the GitHub Advisory API; a file keeps that offline.
    const guardArgs = [join(dir, 'scripts', 'check-overrides.mjs')];
    if (opts.advisoryData) {
      const advisoryPath = join(dir, 'advisories.json');
      writeFileSync(advisoryPath, `${JSON.stringify(opts.advisoryData)}\n`);
      guardArgs.push('--advisory-file', advisoryPath);
    }
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const clean =
      opts.auditReport ??
      JSON.stringify({
        advisories: {},
        metadata: { vulnerabilities: { critical: 0, high: 0, info: 0, low: 0, moderate: 0 } },
      });
    const auditExit = opts.auditExit ?? 0;
    // The stand-in answers BOTH sub-commands the guard uses. What it reports for
    // `config get registry` is the lever of the registry-resolution case below: pointing it at
    // a dead port means a guard that asks pnpm instead of reading the environment reaches
    // nothing, so "the stub was called" becomes a real discriminator rather than a formality.
    const pnpmRegistry = opts.registry ?? 'https://registry.npmjs.org/';
    writeFileSync(
      join(bin, 'pnpm'),
      `#!/bin/sh\ncase "$*" in\n  *'config get registry'*) printf '%s\\n' '${pnpmRegistry}' ;;\n  *) printf '%s' '${clean}'; exit ${auditExit} ;;\nesac\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, 'pnpm.cmd'),
      `@echo off\r\nif "%*"=="config get registry" (echo ${pnpmRegistry}) else (echo ${clean}& exit /b ${auditExit})\r\n`,
    );

    const { createServer } = await import('node:http');
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    // Windows spells it `Path`; adding a second `PATH` key would leave which one wins undefined.
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    try {
      // ASYNC: the stub answers the child from THIS process's event loop (see runAsync()).
      // CHECK_OVERRIDES_ADVISORY_API routes the bulk URL directly and therefore BYPASSES the
      // registry resolution. The default keeps that (it is what the two outage cases need);
      // `useApiOverride: false` steers the probe through the registry environment variable
      // instead (`registryEnv`, default `pnpm_config_registry`), which is the lever a real
      // private registry or proxy pulls.
      const child = spawn(process.execPath, guardArgs, {
        env: {
          ...process.env,
          ...(opts.useApiOverride === false
            ? { [opts.registryEnv ?? 'pnpm_config_registry']: `http://127.0.0.1:${port}/` }
            : { CHECK_OVERRIDES_ADVISORY_API: `http://127.0.0.1:${port}` }),
          CI: '',
          [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}`,
        },
      });
      let out = '';
      let spawnError: Error | undefined;
      child.on('error', (err) => (spawnError = err));
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (out += c));
      const exit = await new Promise<null | number>((resolve) => child.on('close', resolve));
      assertReachedAVerdict(out, spawnError);
      return { exit, out, requests };
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /**
   * @regression   11.41.4 — the clean-tree probe runs at top level and read NPM_ADVISORY_BULK
   *   while that const was still declared further down the script. The ReferenceError landed
   *   in the probe's catch, so every live run with a clean audit reported "npm's advisory
   *   service is unreachable" and verified none of the declared overrides — with the service
   *   answering 200. CI passes `--audit-file` and skips the probe, so only local runs lost it.
   * @seen-failing Point the probe at a binding that does not exist yet, which is what the
   *   temporal dead zone did — registered as mutation `overrides-probe-reads-undeclared-bulk-url`
   *   in tests/regression-mutations.json.
   */
  it('reports the overrides as checked when the advisory service answers', async () => {
    const r = await runLiveClean(200);
    expect(r.requests, 'the probe must actually ask the bulk endpoint').toContain(
      'POST /-/npm/v1/security/advisories/bulk',
    );
    expect(r.out, `a reachable service must not be reported as down, got:\n${r.out}`).not.toMatch(/unreachable/);
    expect(r.out).toMatch(/ok — 1 override\(s\) checked against 0 advisory\/advisories/);
    expect(r.exit).toBe(0);
  });

  it('still says "could not ask" when the service really is down (the paired control)', async () => {
    const r = await runLiveClean(503);
    expect(r.out, `a 503 must be reported as an outage, got:\n${r.out}`).toMatch(/unreachable/);
    expect(r.out).toMatch(/COULD NOT ASK/);
    expect(r.exit, 'an outage must not fail the chain').toBe(0);
  });

  /**
   * @regression   11.42.6 — `configuredRegistry()` asked pnpm and nothing else, in BOTH copies of
   *   the shared block. The probe has to ask the registry the AUDIT used, and the environment can
   *   name one: under pnpm 11 that variable is `pnpm_config_registry`. Reading it first is what
   *   this case pins; the next case pins that it is the RIGHT variable.
   * @seen-failing Drop the environment branch from `configuredRegistry()` — registered as mutation
   *   `probe-registry-ignores-environment` in tests/regression-mutations.json.
   */
  it('asks the registry pnpm AUDITS against, which the environment can name', async () => {
    // The environment names the stub while the fake pnpm reports a DEAD port, which is what
    // makes the assertion sharp: only a guard that reads the environment first reaches the stub
    // at all, and one that trusts pnpm's answer reaches nothing and reports an outage.
    const r = await runLiveClean(200, { registry: 'http://127.0.0.1:1/', useApiOverride: false });
    expect(r.requests, `the audited registry was never asked, got:\n${r.out}`).toContain(
      'POST /-/npm/v1/security/advisories/bulk',
    );
    expect(r.out, `the probe reached the registry, so this is no outage, got:\n${r.out}`).not.toMatch(/unreachable/);
    expect(r.exit).toBe(0);
  });

  /**
   * @regression   11.42.6 — the first version of the environment branch read `npm_config_registry`,
   *   from a measurement on an older pnpm. pnpm 11 IGNORES that variable for the audit (measured
   *   with 11.13.1), so the probe asked a registry the audit never talked to.
   * @seen-failing Read `npm_config_registry` instead of `pnpm_config_registry` in the shared block —
   *   registered as mutation `probe-reads-npm-config-registry` in tests/regression-mutations.json.
   */
  it('ignores npm_config_registry, which pnpm 11 does not audit against', async () => {
    // Inverted levers: the npm variable points at the stub, pnpm reports a DEAD port. A guard that
    // honours the npm variable reaches the stub; one that follows pnpm 11 does not, and reports
    // that it could not ask.
    const r = await runLiveClean(200, {
      registry: 'http://127.0.0.1:1/',
      registryEnv: 'npm_config_registry',
      useApiOverride: false,
    });
    expect(r.requests, `npm_config_registry steered the probe, got:\n${r.out}`).toEqual([]);
    expect(r.out).toMatch(/unreachable/);
    expect(r.exit).toBe(0);
  });

  /**
   * @regression   11.42.6 — pnpm 11 answers an audit it could not run with valid JSON
   *   (`{"error": {"message": "fetch failed"}}`) and no `advisories`. The guard read that as
   *   "0 advisories, none failing" and printed "ok — N override(s) checked", under CI too.
   * @seen-failing Remove the error-report check after the audit is obtained — registered as
   *   mutation `guard-audit-error-reads-as-clean` in tests/regression-mutations.json.
   */
  it('does not report an audit that failed as a clean one', async () => {
    const r = await runLiveClean(200, {
      auditExit: 1,
      auditReport: JSON.stringify({ error: { code: 'pnpm', message: 'fetch failed' } }),
    });
    expect(r.out, `a failed audit must not read as checked, got:\n${r.out}`).not.toMatch(/ok — /);
    expect(r.out).toMatch(/could not obtain an audit report \(fetch failed\)/);
    expect(r.out).toMatch(/NONE of them were verified/);
    expect(r.exit, 'a live run without a report must not fail the chain').toBe(0);
  });

  /**
   * @regression   11.42.6 — the first fix for a failed audit EXITED where it detected one, and the
   *   suppression checks run later. They ask the GitHub Advisory API, not the audit, so they had
   *   nothing to lose by running — but with the early exit a suppressed advisory that had gained a
   *   fix (FIX AVAILABLE, exit 1 before) passed with exit 0 for as long as the audit failed, and
   *   `pnpm audit` hides suppressed advisories completely, so nothing else reported it.
   * @seen-failing Put the early exit back in the failed-audit block — registered as mutation
   *   `guard-unavailable-audit-skips-suppressions` in tests/regression-mutations.json.
   */
  it('still checks the suppressions when the audit failed', async () => {
    const GHSA = 'GHSA-aaaa-bbbb-cccc';
    const failed = JSON.stringify({ error: { code: 'pnpm', message: 'fetch failed' } });
    const fixed = await runLiveClean(200, {
      advisoryData: { [GHSA]: { first_patched_version: '2.1.0', withdrawn: false } },
      auditExit: 1,
      auditReport: failed,
      ignoreGhsas: [GHSA],
    });
    expect(fixed.out, `a fixed suppressed advisory must still be reported, got:\n${fixed.out}`).toMatch(
      /FIX AVAILABLE/,
    );
    expect(fixed.exit).toBe(1);

    // The paired control: an unfixed suppression passes, and the run says which half it verified.
    const unfixed = await runLiveClean(200, {
      advisoryData: { [GHSA]: { first_patched_version: null, withdrawn: false } },
      auditExit: 1,
      auditReport: failed,
      ignoreGhsas: [GHSA],
    });
    expect(unfixed.out).not.toMatch(/ok — /);
    expect(unfixed.out).toMatch(/override\(s\) were NOT verified; 1\/1 suppression\(s\) verified/);
    expect(unfixed.exit).toBe(0);
  });
});
