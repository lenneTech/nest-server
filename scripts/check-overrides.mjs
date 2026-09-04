#!/usr/bin/env node
/**
 * Catches pnpm overrides that LOOK like a security fix and close nothing.
 *
 * An override is written once, in response to an advisory, and then never read
 * again. It ages in place: the advisory gets a higher fixed-in version, or the
 * dependency tree moves and the selector stops matching the path it was written
 * for. In both cases the entry stays in package.json looking exactly like it did
 * on the day it worked.
 *
 * This is not hypothetical. In the `offers` project NINE of twelve overrides had
 * drifted below their advisory's fixed-in version — fast-uri pinned to 3.1.3
 * while the fix was 3.1.6, ip-address to 10.2.0 against 10.3.1, js-yaml to 4.3.0
 * against 4.3.1, and six more. Every one of them had been added deliberately,
 * every one was still listed, and every one left the vulnerability wide open for
 * months. `pnpm audit` reported the advisories the whole time; what nothing
 * reported was that a supposed remedy for each was already sitting in the file.
 *
 * That distinction is the entire point of this script. Reading an audit report
 * with no overrides in view, a maintainer sees "another transitive advisory I
 * probably cannot fix". Reading it against the override list, the same line
 * becomes "the fix is already wired — the number is just too low". In `offers`
 * that was the difference for nine of twelve findings.
 *
 * Reported classes:
 *
 *   ✗ TOO LOW      the override resolves, and delivers a version the advisory
 *                  still covers. Raise the target to the fixed-in version.
 *   ✗ NOT MATCHING an override for the package exists, but the installed version
 *                  differs from its target — the selector does not reach this
 *                  path. Rescope it (`parent>pkg`) or widen it.
 *   ! NO FIX       an override exists, but the advisory has no patched version
 *                  at all (`patched_versions: <0.0.0`). No target can help;
 *                  drop the root dependency or document the residual risk.
 *                  Reported, not failed — there is no green to reach.
 *   ! UNUSED       an override for a package that is not in the lockfile. Dead
 *                  weight that survives long after the dependency is gone.
 *                  Reported, not failed — a pre-emptive pin is legitimate.
 *
 * Advisories WITHOUT an override are deliberately not reported: `pnpm audit`
 * already fails the chain on those, and repeating them here would bury the four
 * classes above in noise.
 *
 * ---------------------------------------------------------------------------
 * Suppressions age the same way, and worse
 * ---------------------------------------------------------------------------
 *
 * `pnpm.auditConfig.ignoreGhsas` is the other half of the same problem, and the
 * blinder one. An override at least stays visible: `pnpm audit` keeps reporting
 * its package, so the entry can be caught by reading the report. A suppressed
 * advisory is REMOVED from `pnpm audit --json` entirely — `advisories` drops it
 * and `muted` comes back empty — so once a GHSA is listed there, no audit run
 * will ever mention it again. If upstream publishes a fix tomorrow, nothing
 * says so. The entry was justified on the day it was written and silently stops
 * being justified without any signal.
 *
 * So every listed GHSA is checked against the GitHub Advisory API. Public advisories
 * need no token, but one is SENT when `GITHUB_TOKEN` / `GH_TOKEN` is set: unauthenticated
 * the quota is 60 requests/hour PER IP, and hosted CI runners share IPs across every
 * repository on them. Since an unverified suppression FAILS the run under CI, a shared-IP
 * quota would otherwise surface as a red pipeline that reads like a security finding. With
 * a token the quota is 1000/hour for the repository. A rate-limited run says so explicitly.
 *
 *   ✗ FIX AVAILABLE  the advisory now has a `first_patched_version`, or was
 *                    withdrawn. The suppression is obsolete — take the fix and
 *                    drop the entry.
 *
 * This is a network call, so it is skipped (with a WARN naming the unverified
 * GHSAs) when the API cannot be reached, exactly like the audit itself.
 *
 * A note against a tempting shortcut: `pnpm audit --ignore-unfixable` looks like
 * it solves this without any list at all. Both observations below were MEASURED
 * UNDER pnpm 10.33.1, and the version matters — see the caveat at the end.
 *
 *   - It returns exit 0 even when a FIXABLE advisory is present. Verified by
 *     putting fast-uri back to 3.1.3 against a >=3.1.6 advisory: plain
 *     `pnpm audit` exits 1, the same run with `--ignore-unfixable` exits 0.
 *   - It writes an `auditConfig.ignoreCves` block into package.json as a side
 *     effect of merely being run.
 *
 * Under pnpm 11 the second half cannot happen: `ignoreCves` does not appear
 * anywhere in the bundle, while `ignoreGhsas` and `auditConfig` do — the key was
 * dropped. The flag itself still exists there. Whether the exit-0 masking survived
 * into 11 is UNTESTED; it needs a pnpm 11 tree carrying a real fixable advisory.
 *
 * Re-verified 2026-09-03 against the version this repo actually PINS (11.13.1, per
 * `packageManager`) rather than the 11.14.0 originally inspected — a claim about a
 * version the repo does not run is itself a watchman looking in the wrong place.
 * Counted in `.../corepack/v1/pnpm/11.13.1/artifacts/exe/dist/pnpm.mjs`:
 * `ignoreCves` 0, `ignoreGhsas` 11, `auditConfig` 8, `--ignore-unfixable` present.
 *
 * Recording the version is the point. A warning about behaviour the pinned pnpm
 * no longer has is itself a watchman looking in the wrong place — the failure
 * this whole script exists to catch. An explicit GHSA list plus the suppression
 * check above is the honest version either way.
 *
 * Usage:
 *   node scripts/check-overrides.mjs
 *   node scripts/check-overrides.mjs --audit-file <report.json>
 *   node scripts/check-overrides.mjs --advisory-file <advisories.json>
 *
 * `--audit-file` reads a previously captured `pnpm audit --json` instead of
 * running one — useful in CI, where the chain already produces a report, and to
 * inspect a colleague's findings without their tree. `--advisory-file` does the
 * same for the GHSA lookups: a JSON object mapping each GHSA id to
 * `{ first_patched_version, withdrawn }`, so the suppression check is
 * reproducible offline.
 *
 * Exit code: 0 when no override and no suppression is failing its job, 1 otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAG = '[overrides]';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const pkg = readJson(join(ROOT, 'package.json'));
if (!pkg) {
  console.error(`${TAG} FAIL — cannot read package.json at ${ROOT}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Where the settings live depends on the pnpm major, and getting this wrong
// makes the whole guard silently useless.
//
// pnpm 10 reads `pnpm.overrides` / `pnpm.auditConfig` from package.json.
// pnpm 11 does NOT read the `pnpm` field at all — it says so on every run:
//
//   [WARN] The "pnpm" field in package.json is no longer read by pnpm. The
//   following keys were ignored: "pnpm.overrides", "pnpm.auditConfig", ...
//
// and expects them in pnpm-workspace.yaml instead. A guard that only knew
// package.json would report "no overrides declared" for every pnpm 11 workspace
// — a watchman finding nothing and reporting it as the all-clear, which is the
// exact failure this script exists to catch. So both homes are read, always.
// ---------------------------------------------------------------------------

/**
 * Reads one block from pnpm-workspace.yaml.
 *
 * Deliberately a small block reader rather than a YAML dependency: these guard
 * scripts run before install and must stay dependency-free (check.mjs and
 * check-workspace-consistency.mjs parse `packages:` the same way). It handles
 * the shapes pnpm actually writes — `key: value` maps and `- item` lists under
 * a top-level or once-nested key — and nothing more.
 */
function workspaceBlock(text, path) {
  const [head, nested] = path;
  const lines = text.split('\n');

  let start = -1;
  let baseIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^(\\s*)${head}:\\s*(#.*)?$`));
    if (m) {
      start = i + 1;
      baseIndent = m[1].length;
      break;
    }
  }
  if (start === -1) {
    return null;
  }

  const body = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) {
      break;
    }
    body.push(line);
  }

  if (nested) {
    return workspaceBlock(body.join('\n'), [nested]);
  }
  return body;
}

/** Strips a trailing comment and surrounding quotes from a scalar. */
function scalar(raw) {
  return raw
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

const workspaceYaml = (() => {
  try {
    return readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  } catch {
    return '';
  }
})();

function workspaceMap(path) {
  const body = workspaceBlock(workspaceYaml, path);
  if (!body) {
    return {};
  }
  const out = {};
  for (const line of body) {
    // `"key": "value"` and `key: value`. Split on the FIRST `:` followed by whitespace
    // — the lazy `.*?` is what makes it the first, and the mandatory `\s` after the colon
    // is what keeps a colon INSIDE a key (`bar>foo@<1.2.3`, a scoped name, a URL) from
    // ending it, since those are never followed by a space.
    const m = line.trim().match(/^(.*?):\s*(\S.*)$/);
    if (m) {
      out[scalar(m[1])] = scalar(m[2]);
    }
  }
  return out;
}

function workspaceList(path) {
  const body = workspaceBlock(workspaceYaml, path);
  if (!body) {
    return [];
  }
  return body
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => scalar(line.slice(2)));
}

// pnpm reads `pnpm.overrides` (10) or the workspace `overrides:` (11); npm and
// yarn use a top-level `overrides`/`resolutions`. A workspace mid-migration can
// carry several at once, so honour all of them rather than checking nothing.
const overrides = {
  ...pkg.resolutions,
  ...pkg.overrides,
  ...pkg.pnpm?.overrides,
  ...workspaceMap(['overrides']),
};

// Suppressed advisories. Read before the early exit below, because a repo may
// suppress advisories without declaring a single override — and that is exactly
// the state in which nothing else is watching.
const suppressed = [
  ...new Set([
    ...(pkg.pnpm?.auditConfig?.ignoreGhsas ?? []),
    ...(pkg.auditConfig?.ignoreGhsas ?? []),
    ...workspaceList(['auditConfig', 'ignoreGhsas']),
  ]),
].filter((id) => typeof id === 'string' && id.startsWith('GHSA-'));

// ---------------------------------------------------------------------------
// Settings that pnpm 11 no longer reads
// ---------------------------------------------------------------------------
// The migration is silent in the direction that matters. Moving to pnpm 11
// without moving these blocks does not fail anything: overrides simply stop
// applying and suppressions stop suppressing, while the entries sit in
// package.json looking exactly as deliberate as the day they were written. For
// a project carrying dozens of security overrides that is the whole protection
// gone at once, announced only by a WARN line in the install output.
const pnpmMajor = Number((pkg.packageManager ?? '').match(/^pnpm@(\d+)\./)?.[1] ?? 0);
const strandedKeys = pnpmMajor >= 11 ? ['overrides', 'auditConfig'].filter((key) => pkg.pnpm?.[key]) : [];

// ---------------------------------------------------------------------------
// "Found the key, parsed zero entries" must never render as "all clear"
// ---------------------------------------------------------------------------
// The block reader above understands the shapes pnpm writes today. It does NOT
// understand a flow sequence (`ignoreGhsas: [GHSA-…]`) or a flow mapping
// (`overrides: { … }`), both of which pnpm reads perfectly well. Reformat the file
// into either and every entry becomes invisible — same semantics, opposite verdict,
// and the run still ends `ok`. That is this script's own stated failure mode, so the
// one thing it must not do is stay quiet about it: if the YAML declares a block and
// we came away with nothing, say so loudly rather than reporting an all-clear.
// An EXPLICITLY empty block (`ignoreGhsas: []`) is a decision, not a parse failure, and
// this repo's is deliberate with a written justification above it. Warning about it would
// put a permanent line in every run — and a warning that is always there is one nobody
// reads, which is the failure this script exists to prevent, committed by the fix for it.
const declaredEmpty = (leaf) =>
  new RegExp(`^\\s*${leaf}:\\s*(\\[\\s*\\]|\\{\\s*\\})\\s*(#.*)?$`, 'm').test(workspaceYaml);
const declaresKey = (leaf) => new RegExp(`^\\s*${leaf}:`, 'm').test(workspaceYaml);

for (const [leaf, label, parsed] of [
  ['overrides', 'overrides', Object.keys(workspaceMap(['overrides'])).length],
  ['ignoreGhsas', 'auditConfig.ignoreGhsas', workspaceList(['auditConfig', 'ignoreGhsas']).length],
]) {
  if (parsed === 0 && declaresKey(leaf) && !declaredEmpty(leaf)) {
    console.warn(
      `${TAG} WARN — pnpm-workspace.yaml declares "${leaf}:" but this guard parsed 0 entries for ${label}.\n` +
        '      That is a YAML shape the block reader does not handle (flow style: `{ … }` / `[ … ]`),\n' +
        '      so every entry under it is UNVERIFIED and this run proves nothing about them.\n' +
        '      Convert the block to the indented form, or write it explicitly empty as `[]`.',
    );
  }
}

const overrideCount = Object.keys(overrides).length;
if (overrideCount === 0 && suppressed.length === 0) {
  console.log(`${TAG} ok — no overrides and no suppressions declared, nothing to verify`);
  process.exit(0);
}

/**
 * Extracts the package name an override key targets.
 *
 * pnpm keys come in five shapes, and the version selector is separated by an `@`
 * that a scoped name already contains:
 *
 *   "foo"                    -> foo
 *   "foo@<1.2.3"             -> foo
 *   "foo@>=1.0.0 <2.0.0"     -> foo
 *   "@scope/foo@2"           -> @scope/foo
 *   "bar>@scope/foo"         -> @scope/foo   (only under bar)
 *
 * `>` CARRIES TWO MEANINGS HERE, and conflating them is the bug this guard shipped
 * with. It is pnpm's scope separator in `parent>child`, and it is a version
 * operator in `>=`. A plain `key.split(">")` turned
 *
 *   "ws@>=8.0.0 <8.21.0"  into  "=8.0.0 <8.21.0"
 *
 * — a name no advisory ever matches. The override was then skipped entirely
 * (`keys.length === 0` → `continue`), so TOO LOW and NOT MATCHING could never fire
 * for it, while the run still ended in "N override(s) checked ... none is failing"
 * and exit 0. Ten of nest-server's seventeen overrides use that form, and the
 * suite's own key-shape tests covered `parent>@scope/pkg` and `pkg@1` but not this
 * one. A watchman that counts a key it cannot parse as a key it checked is the
 * exact failure this script exists to catch, and it had it.
 *
 * The two meanings are distinguishable: a version operator always follows `@`, an
 * earlier operator, or a space. Only a `>` preceded by none of those separates
 * package names.
 */
function targetPackage(key) {
  const last = key
    .split(/(?<![@<>=\s])>/)
    .pop()
    .trim();
  const at = last.indexOf('@', last.startsWith('@') ? 1 : 0);
  return at === -1 ? last : last.slice(0, at);
}

// ---------------------------------------------------------------------------
// The audit report
// ---------------------------------------------------------------------------

const fileFlag = process.argv.indexOf('--audit-file');
let report = null;
let source = '';

if (fileFlag !== -1) {
  const path = process.argv[fileFlag + 1];
  if (!path) {
    console.error(`${TAG} FAIL — --audit-file needs a path`);
    process.exit(1);
  }
  report = readJson(path);
  if (!report) {
    console.error(`${TAG} FAIL — cannot read audit report at ${path}`);
    process.exit(1);
  }
  source = path;
} else {
  try {
    // `pnpm audit` exits non-zero WHENEVER it finds anything, which is the normal
    // case here — the report on stdout is what matters, not the status. Only a
    // missing/garbled payload counts as a failure to run.
    const stdout = execFileSync('pnpm', ['audit', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 180_000,
    });
    report = JSON.parse(stdout);
    source = 'pnpm audit';
  } catch (err) {
    const stdout = err?.stdout;
    if (typeof stdout === 'string' && stdout.trim().startsWith('{')) {
      try {
        report = JSON.parse(stdout);
        source = 'pnpm audit';
      } catch {
        report = null;
      }
    }
    if (!report) {
      // The registry is unreachable, or pnpm is too old for `--json`. Skipping is
      // right — a laptop on a train must not fail the chain. Saying so on stderr
      // is what keeps the skip from reading as a pass; check-playwright-image.mjs
      // learned that the expensive way when its pins drifted eleven days behind a
      // green check that had verified nothing.
      console.warn(
        `${TAG} WARN — could not obtain an audit report (${(err?.message ?? 'unknown error').split('\n')[0]}).\n` +
          `  ${overrideCount} override(s) are declared and NONE of them were verified.\n` +
          `  Re-run with network access, or pass a captured report:\n` +
          `    pnpm audit --json > audit.json && node scripts/check-overrides.mjs --audit-file audit.json`,
      );
      process.exit(0);
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-reference: which advisories land on a package we already override?
// ---------------------------------------------------------------------------

const advisories = Object.values(report.advisories ?? {});

// ---------------------------------------------------------------------------
// A clean tree and a dead advisory service look IDENTICAL in pnpm's output
// ---------------------------------------------------------------------------
// When npm's advisory endpoint (/-/npm/v1/security/advisories/bulk) is down,
// `pnpm audit --json` still exits 0 and returns a report that is byte-comparable
// to a genuinely clean one: `advisories` present but empty, every count in
// `metadata.vulnerabilities` zero, no error envelope. Measured against the real
// outage on 2026-09-04, with the registry itself answering 200 in 0.17s.
//
// This guard reported "ok — N override(s) checked against 0 advisory/advisories
// ... none is failing", exit 0, and that sentence was false: it had not checked
// anything. It only warned in the run where pnpm timed out hard enough to throw;
// a graceful empty answer sailed straight through. A watchman reporting an
// all-clear about a question it never got to ask is the exact failure this
// script exists to catch, and it had it — found by lt-monorepo-00, who hit the
// same outage and noticed that "0 advisories" reads as "nothing found" when it
// means "could not look".
//
// So the ambiguous shape is detected, and only then is the service asked
// directly. A report WITH findings needs no probe: findings prove it answered.
const ambiguouslyEmpty =
  advisories.length === 0 &&
  report.advisories !== undefined &&
  Object.values(report.metadata?.vulnerabilities ?? {}).every((n) => !n);

let advisoryServiceDown = false;
if (ambiguouslyEmpty && fileFlag === -1) {
  // Only for a live audit. With --audit-file the caller supplied the report and
  // owns its provenance; probing the network there would contradict the flag's
  // whole purpose (an offline, reproducible run).
  try {
    const res = await fetch(`${NPM_ADVISORY_BULK}`, {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(8000),
    });
    advisoryServiceDown = !res.ok && res.status >= 500;
  } catch {
    advisoryServiceDown = true;
  }
}

if (advisoryServiceDown) {
  // DEGRADE, DO NOT FAIL — and the distinction is narrower than it looks.
  //
  // The lie to prevent is a GREEN "N override(s) checked ... none is failing" after a
  // question that was never asked. Exiting 1 also prevents it, but at a price nobody can
  // pay: npm's advisory endpoint was intermittently down for hours on 2026-09-04, and a
  // hard failure means no `check` can go green in such a window — no release, no sign-off,
  // because of somebody else's infrastructure. That is the same argument this repo already
  // wrote down for the audit step: a gate that is permanently red trains people to ignore
  // red, which is the real hazard. It is also the argument I made for suppressing the three
  // unfixable advisories rather than living with a red chain.
  //
  // So the run continues, and the SUCCESS LINE IS SUPPRESSED instead. Nothing below prints
  // "none is failing", because nothing was checked. Loud, honest, and not blocking.
  //
  // Kept coherent with `check.mjs` on purpose: both steps run in the same chain two apart,
  // and until now one degraded while the other aborted — the reader got two contradictory
  // verdicts about one outage, and the degradation was pointless because the later step
  // decided. Raised by nest-server-5f, who measured exactly that.
  console.warn(
    `${TAG} WARN — the audit reported an empty tree, but npm's advisory service is unreachable.\n` +
      `  "0 advisories" here means "COULD NOT ASK", not "nothing found": pnpm exits 0 and\n` +
      `  returns an identical empty report either way. This run verified NOTHING about the\n` +
      `  ${overrideCount} override(s) declared.\n` +
      `  Not failing the chain — an npm outage is not a finding about this repo and no\n` +
      `  change here fixes it. Re-run when the service is back, or pass a captured report\n` +
      `  with --audit-file, before treating any override as verified.`,
  );
  process.exit(0);
}

// One entry per override key, so an override that is right for one advisory and
// wrong for another is reported per advisory rather than collapsed into one line.
const tooLow = [];
const notMatching = [];
const noFix = [];

for (const advisory of advisories) {
  const module = advisory.module_name;
  if (!module) {
    continue;
  }

  const keys = Object.keys(overrides).filter((key) => targetPackage(key) === module);
  if (keys.length === 0) {
    continue; // no override for this package — `pnpm audit` already reports it
  }

  const installed = [...new Set((advisory.findings ?? []).map((f) => f.version).filter(Boolean))];
  const paths = (advisory.findings ?? []).flatMap((f) => f.paths ?? []);
  const patched = advisory.patched_versions ?? '';
  // npm's advisory schema spells "there is no fix" as an empty range. Any target
  // is futile, so this must not be reported as "too low" — that would send the
  // reader looking for a number that does not exist.
  const unfixable = patched.trim() === '<0.0.0' || patched.trim() === '';

  for (const key of keys) {
    const target = String(overrides[key]);
    const entry = {
      installed,
      key,
      module,
      patched,
      paths: paths.slice(0, 3),
      severity: advisory.severity ?? 'unknown',
      target,
      title: advisory.title ?? '',
    };

    if (unfixable) {
      noFix.push(entry);
      continue;
    }

    // The override resolves and still delivers a vulnerable version: its target
    // is simply below the fix. The comparison is on the resolved version rather
    // than on the declared range, because the range may carry a `^`/`>=` while
    // the tree resolved something else entirely.
    const targetIsInstalled = installed.some((v) => v === target || target.endsWith(v));
    if (targetIsInstalled || installed.length === 0) {
      tooLow.push(entry);
    } else {
      notMatching.push(entry);
    }
  }
}

// ---------------------------------------------------------------------------
// Suppressed advisories: is any of them fixed by now?
// ---------------------------------------------------------------------------

const obsoleteSuppressions = [];
/** Set when the Advisory API refused a lookup because the quota was exhausted. */
let advisoryRateLimited = false;

/**
 * Base URL for the Advisory API — overridable, but ONLY to a loopback address.
 *
 * The rate-limit branch below is the one piece of logic here that cannot be reached through
 * `--advisory-file`, because that flag exists precisely to bypass `fetch`. Without a seam it
 * would be untestable, and untested branches in a security guard are what this whole script
 * is about: a rule only ever asserted in its passing state is indistinguishable from one that
 * is never evaluated.
 *
 * The loopback restriction is what makes the seam safe to ship. A plain env var would be a
 * redirect switch for a security check — anything that sets the environment could point the
 * suppression lookup at a server that answers "no fix exists" forever. Refusing every
 * non-loopback value means the override is usable from a test and inert everywhere else,
 * including CI. A rejected value is announced rather than silently ignored, so a typo does
 * not look like it worked.
 */
const ADVISORY_API_BASE = (() => {
  const override = process.env.CHECK_OVERRIDES_ADVISORY_API;
  if (!override) {
    return 'https://api.github.com';
  }
  try {
    const url = new URL(override);
    if (['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname)) {
      return url.origin;
    }
  } catch {
    /* not a URL — falls through to the warning below */
  }
  console.warn(
    `${TAG} WARN — ignoring CHECK_OVERRIDES_ADVISORY_API="${override}": only a loopback address\n` +
      '      (127.0.0.1, ::1, localhost) is honoured. Using the real Advisory API.',
  );
  return 'https://api.github.com';
})();

/**
 * npm's bulk advisory endpoint, used only to tell "clean tree" apart from "service down".
 *
 * Routed through the SAME loopback override as the GitHub lookups. It was hardcoded at first,
 * which made the ambiguity branch below unreachable from a test — the seam existed two hundred
 * lines away and this call ignored it. Found by nest-server-5f, who measured that
 * CHECK_OVERRIDES_ADVISORY_API=http://127.0.0.1:1 still hit the real service here. Same shape
 * as the rate-limit branch we found the same way: plausible, necessary, and never once executed.
 *
 * The DEFAULT was wrong for a second reason, found later the same day: it named npmjs.org while
 * pnpm audits against the CONFIGURED registry. Behind a private registry or a proxy that produces
 * the false-green this probe exists to remove, one layer down — the real registry is unreachable,
 * npmjs.org answers, and the ambiguity resolves to "clean".
 *
 * The two helpers below are DUPLICATED from `check.mjs` on purpose, not by oversight. This guard is
 * copied ALONE into a temp directory by `tests/unit/check-overrides.guard.spec.ts` and run there —
 * that isolation is what proves it is standalone, and importing a sibling breaks it (tried; 40 cases
 * went red with ERR_MODULE_NOT_FOUND, caught only because `assertReachedAVerdict()` refuses to let a
 * crash read as a verdict). Drift is prevented instead by
 * `tests/unit/shared-registry-resolution.spec.ts`, which asserts the marked block is byte-identical
 * in both files — a check, not a hope.
 */
// >>> SHARED-WITH-CHECK-MJS (kept verbatim; see the note below)
function configuredRegistry() {
  try {
    return execFileSync('pnpm', ['config', 'get', 'registry'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function advisoryBulkUrl(registry) {
  const fallback = 'https://registry.npmjs.org/';
  let base = typeof registry === 'string' ? registry.trim() : '';
  if (!/^https?:\/\//i.test(base)) {
    base = fallback;
  }
  return `${base.replace(/\/+$/, '')}/-/npm/v1/security/advisories/bulk`;
}
// <<< SHARED-WITH-CHECK-MJS

const NPM_ADVISORY_BULK =
  ADVISORY_API_BASE === 'https://api.github.com'
    ? advisoryBulkUrl(configuredRegistry())
    : `${ADVISORY_API_BASE}/-/npm/v1/security/advisories/bulk`;

const uncheckedSuppressions = [];

/** Reads GHSA metadata, from a captured file when given, else from GitHub. */
async function advisoryStatus(ids) {
  const advisoryFlag = process.argv.indexOf('--advisory-file');
  if (advisoryFlag !== -1) {
    const path = process.argv[advisoryFlag + 1];
    const data = path ? readJson(path) : null;
    if (!data) {
      console.error(`${TAG} FAIL — cannot read advisory file at ${path ?? '<missing path>'}`);
      process.exit(1);
    }
    return new Map(ids.map((id) => [id, data[id] ?? null]));
  }

  // Concurrent, because the failure mode is the offline one. Each lookup carries a 20s
  // timeout, so a serial loop on a laptop without network spends 20s PER suppression
  // before reaching the same "unchecked" verdict — 200s at ten entries, silent enough
  // that check.mjs's idle watchdog could plausibly kill the step. The audit path a few
  // lines up short-circuits for exactly that reason ("a laptop on a train must not fail
  // the chain"); this one has to honour the same promise. Bounded by construction: `ids`
  // is the hand-written suppression list, so there is nothing to rate-limit.
  //
  // A token is sent when one is available, and on GitHub Actions one always is
  // (`secrets.GITHUB_TOKEN`, forwarded by the workflow). Unauthenticated the Advisory API
  // allows 60 requests/hour PER IP, and hosted runners share IPs across every repository on
  // them — so on a busy runner the limit is reachable through no fault of this repo. That
  // matters more since a rate-limited lookup FAILS the run under CI: without a token, a
  // shared-IP quota would surface as a red pipeline that reads like a security finding.
  // With the token the quota is 1000/hour for the repository, which a hand-written
  // suppression list cannot approach.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = { accept: 'application/vnd.github+json' };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const entries = await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await fetch(`${ADVISORY_API_BASE}/advisories/${encodeURIComponent(id)}`, {
          headers,
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
          // 403/429 with the quota exhausted is a DIFFERENT fact from "the advisory could
          // not be read", and conflating them is what would make a shared-runner quota look
          // like a finding. Recorded so the report can name it and say what to do.
          if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
            advisoryRateLimited = true;
          }
          return [id, null];
        }
        const body = await res.json();
        // An advisory carries one entry per affected package; a fix for ANY of them
        // means the suppression deserves a second look, so take the first non-null.
        const patched = (body.vulnerabilities ?? []).map((v) => v.first_patched_version).find((v) => v);
        return [id, { first_patched_version: patched ?? null, withdrawn: Boolean(body.withdrawn_at) }];
      } catch {
        return [id, null]; // unreachable — reported as unchecked, never as "still fine"
      }
    }),
  );
  return new Map(entries);
}

if (suppressed.length > 0) {
  const status = await advisoryStatus(suppressed);
  for (const id of suppressed) {
    const info = status.get(id);
    if (!info) {
      uncheckedSuppressions.push(id);
    } else if (info.withdrawn || info.first_patched_version) {
      obsoleteSuppressions.push({ id, ...info });
    }
  }
}

// ---------------------------------------------------------------------------
// Overrides for packages that are not in the tree at all
// ---------------------------------------------------------------------------

const unused = [];
const lockPath = join(ROOT, 'pnpm-lock.yaml');
if (existsSync(lockPath)) {
  const lock = readFileSync(lockPath, 'utf8');
  for (const key of Object.keys(overrides)) {
    const module = targetPackage(key);
    // Lockfile entries are keyed `/name@version` (v6+) or `name@version:` (v9+).
    // A substring test would match `tar` inside `tar-stream`, so anchor on the
    // delimiter that always follows the name.
    const escaped = module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(^|[/'"\\s])${escaped}@`, 'm').test(lock)) {
      unused.push({ key, module, target: String(overrides[key]) });
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function describe(entry) {
  const where = entry.paths.length > 0 ? `\n      via ${entry.paths.join('\n      via ')}` : '';
  const found = entry.installed.length > 0 ? entry.installed.join(', ') : 'not resolved';
  return (
    `${entry.module} (${entry.severity}) — ${entry.title}\n` +
    `      override "${entry.key}": "${entry.target}"  →  installed ${found}, advisory fixed in ${entry.patched}${where}`
  );
}

if (noFix.length > 0) {
  console.warn(`${TAG} WARN — ${noFix.length} override(s) target a package with no published fix:\n`);
  for (const entry of noFix) {
    console.warn(
      `  ! ${entry.module} — override "${entry.key}": "${entry.target}"\n` +
        `      the advisory has no patched version (${entry.patched}); no target can close it.\n` +
        `      Drop the root dependency, or record it as an accepted residual risk.`,
    );
  }
  console.warn('');
}

if (unused.length > 0) {
  console.warn(`${TAG} WARN — ${unused.length} override(s) for packages absent from the lockfile:\n`);
  for (const entry of unused) {
    console.warn(`  ! "${entry.key}": "${entry.target}" — ${entry.module} is not in the tree`);
  }
  console.warn('  A pre-emptive pin is legitimate; a leftover from a removed dependency is noise.\n');
}

if (uncheckedSuppressions.length > 0) {
  console.warn(
    `${TAG} WARN — could not reach the GitHub Advisory API for ` +
      `${uncheckedSuppressions.length} suppressed advisory/advisories:\n` +
      uncheckedSuppressions.map((id) => `  ! ${id} — UNVERIFIED, a fix may exist by now`).join('\n') +
      `\n  These are invisible to \`pnpm audit\` by design, so nothing else will mention them.\n` +
      (advisoryRateLimited
        ? '  CAUSE: the Advisory API quota is exhausted for this IP (60/hour unauthenticated).\n' +
          '  Set GITHUB_TOKEN — on GitHub Actions pass `secrets.GITHUB_TOKEN`, which raises it to\n' +
          '  1000/hour for the repository. This is a quota, NOT a finding about the advisories.\n'
        : ''),
  );
}

// An UNVERIFIED suppression is a skip, and a skip is only acceptable where a human sees the
// warning scroll past. On a runner nobody reads stderr on a green step, so the same output that
// keeps a developer honest reads as a pass — the `check-playwright-image.mjs` failure this
// script's header cites, committed by this script. Suppressed advisories are invisible to
// `pnpm audit` by design, so nothing else would catch it either. In CI, therefore, "could not
// check" is a failure rather than a note.
const ciUnverified = Boolean(process.env.CI) && uncheckedSuppressions.length > 0;
if (ciUnverified) {
  console.error(
    `${TAG} FAIL — running under CI with ${uncheckedSuppressions.length} suppression(s) that could not be ` +
      'verified against the GitHub Advisory API.\n' +
      '      A suppressed advisory is invisible to `pnpm audit`, so an unchecked one is not "probably\n' +
      '      still fine" — it is unknown. Re-run, or pass --advisory-file with captured metadata.' +
      (advisoryRateLimited
        ? '\n      This run was RATE LIMITED, which is a quota problem and not a security one:\n' +
          '      set GITHUB_TOKEN (on GitHub Actions: `secrets.GITHUB_TOKEN`) before reading it as a finding.'
        : ''),
  );
}

if (
  ciUnverified ||
  strandedKeys.length > 0 ||
  obsoleteSuppressions.length > 0 ||
  tooLow.length > 0 ||
  notMatching.length > 0
) {
  console.error(`${TAG} override(s) or suppression(s) declared as a fix are not fixing anything:\n`);
  for (const key of strandedKeys) {
    const count = Object.keys(pkg.pnpm[key] ?? {}).length;
    console.error(
      `  ✗ NOT READ     package.json "pnpm.${key}" (${count} entr${count === 1 ? 'y' : 'ies'}) — ` +
        `this workspace pins pnpm ${pnpmMajor}, which does not read the "pnpm" field at all.\n` +
        `      Every entry there is inert: overrides do not apply, suppressions do not suppress.\n` +
        `      Move the block to pnpm-workspace.yaml. https://pnpm.io/settings\n`,
    );
  }
  for (const entry of obsoleteSuppressions) {
    const why = entry.withdrawn ? 'the advisory was WITHDRAWN' : `a fix exists: ${entry.first_patched_version}`;
    console.error(
      `  ✗ FIX AVAILABLE ${entry.id} — ${why}.\n` +
        `      The suppression in auditConfig.ignoreGhsas is obsolete: take the fix\n` +
        `      and remove the entry. https://github.com/advisories/${entry.id}\n`,
    );
  }
  for (const entry of tooLow) {
    console.error(`  ✗ TOO LOW      ${describe(entry)}\n      Raise the target to ${entry.patched}.\n`);
  }
  for (const entry of notMatching) {
    console.error(
      `  ✗ NOT MATCHING ${describe(entry)}\n` +
        `      The selector does not reach that path — rescope it ("parent>${entry.module}") or widen it.\n`,
    );
  }
  const parts = [];
  if (strandedKeys.length > 0) {
    parts.push(`${strandedKeys.length} block(s) pnpm no longer reads`);
  }
  if (tooLow.length + notMatching.length > 0) {
    parts.push(
      `${tooLow.length + notMatching.length} failing override(s) across ${advisories.length} advisory/advisories`,
    );
  }
  if (obsoleteSuppressions.length > 0) {
    parts.push(`${obsoleteSuppressions.length} obsolete suppression(s)`);
  }
  if (ciUnverified) {
    parts.push(`${uncheckedSuppressions.length} unverified suppression(s) under CI`);
  }
  console.error(`${TAG} ${parts.join(', ')}`);
  process.exit(1);
}

const covered = advisories.filter((a) =>
  Object.keys(overrides).some((key) => targetPackage(key) === a.module_name),
).length;

const verifiedSuppressions = suppressed.length - uncheckedSuppressions.length;

console.log(
  `${TAG} ok — ${overrideCount} override(s) checked against ${advisories.length} advisory/advisories ` +
    `from ${source}; ${covered} of them land on an overridden package and none is failing` +
    (suppressed.length > 0
      ? `; ${verifiedSuppressions}/${suppressed.length} suppression(s) confirmed to still have no fix`
      : ''),
);
