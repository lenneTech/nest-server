#!/usr/bin/env node
/**
 * Quiet, report-driven wrapper around the project `check` pipeline.
 *
 * Replaces the noisy `pnpm audit && pnpm -r --parallel run check` with:
 *   - a minimal live view — one status line per running project (spinner +
 *     current step), so you always see where the run is;
 *   - abort on the first failing step, printing the captured reason;
 *   - on success a report: the executed steps + their key metrics
 *     (vulnerabilities per level, test counts per area Unit/API/Playwright, …);
 *   - format + lint auto-fix every fixable finding (oxfmt writes, oxlint --fix);
 *     only non-fixable lint errors then remain and fail the run.
 *
 * Flags:
 *   --verbose / -v      stream the full tool output live (deep debugging)
 *   --sequential/--seq  run projects one after another (default: parallel)
 *   --no-fix            read-only gate — do not auto-fix format/lint
 *   --project=<substr>  restrict to matching workspace projects (repeatable)
 *
 * Design: the per-project `check` scripts stay the single source of truth for
 * WHAT runs. This wrapper discovers each workspace project's `check` chain,
 * splits it on `&&`, and runs the steps with status + metrics — so adding or
 * removing a step in a project's `check` needs no change here.
 *
 * Exit code: 0 when every step passed, 1 otherwise (preserves the contract the
 * lt-dev `running-check-script` skill relies on: non-zero === failed).
 */
import { execFileSync, execSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const SEQUENTIAL = process.argv.includes('--sequential') || process.argv.includes('--seq');
const NO_FIX = process.argv.includes('--no-fix');
const PROJECT_FILTERS = process.argv.filter((a) => a.startsWith('--project=')).map((a) => a.slice('--project='.length));
// Watchdog: kill a TEST step whose child produces NO output for this long. A
// wedged test run (workers deadlocked at 0% CPU) otherwise spins the live view
// forever — the spinner only proves the child process exists, not that it
// progresses. Only test steps are watched: build / typecheck / audit legitimately
// buffer all their output to the end (and go silent under a non-TTY pipe), so
// watching them would false-kill a slow-but-progressing run. Override with
// --idle-timeout=<seconds> or CHECK_IDLE_TIMEOUT (seconds); 0 disables it.
const IDLE_TIMEOUT_MS = (() => {
  const flag = process.argv.find((a) => a.startsWith('--idle-timeout='));
  const raw = flag ? flag.slice('--idle-timeout='.length) : process.env.CHECK_IDLE_TIMEOUT;
  const DEFAULT_MS = 300 * 1000;
  if (raw === undefined || raw === '') return DEFAULT_MS;
  const seconds = Number(raw);
  if (seconds === 0) return 0; // explicit opt-out
  // Invalid value (typo, unit suffix, negative) → keep the protection at its
  // default rather than silently disabling it — a fat-fingered value must not
  // turn the watchdog off unnoticed.
  if (!Number.isFinite(seconds) || seconds < 0) {
    process.stderr.write(`[check] ignoring invalid idle-timeout "${raw}", using ${DEFAULT_MS / 1000}s\n`);
    return DEFAULT_MS;
  }
  return seconds * 1000;
})();
// Absolute cap for the AUDIT step only — the hang guard. `pnpm audit` against an unreachable
// registry does not fail, it hangs: no output, no exit, no error envelope, so none of the degraded
// signatures can fire (each needs the process to have spoken). `check` then waits forever, which is
// strictly worse than a red run — a failure tells you something, a hang tells you nothing.
//
// ABSOLUTE, not idle — and idle is not merely the worse choice here, it cannot work at all.
// Measured by lt-monorepo-00: `pnpm audit --json` emits NO intermediate output; the whole response
// arrives in one piece at the end (~120 bytes). An idle watchdog therefore sees exactly the same
// thing during a healthy run as during a hang: nothing. Its runtimes:
//
//     healthy            0.5s / 0.7s / 0.8s
//     service struggling 45.8s / 1m12s / 2m34s
//     hung               >240s, zero bytes
//
// An idle cap would have to sit above 2m34s not to kill a working run — at which point it is barely
// sharper than an absolute one, with more moving parts. There is no window where idle wins.
//
// 10 minutes is deliberately generous: the longest REAL audit measured here was 4m11s (pnpm's own
// retry ladder running out against the npm advisory outage of 2026-09-04). More than double that
// leaves slow-but-progressing runs alone while still bounding an infinite one. Override with
// CHECK_AUDIT_TIMEOUT (seconds); 0 disables it.
//
// TWO CAPS, ONE REASON, DIFFERENT COSTS — not drift, do not "unify" them. lt-monorepo's CI script
// caps the same thing at 180s on purpose: a hung CI job burns a runner, a hung local check costs
// patience. Ten minutes is generous locally and expensive in CI.
const AUDIT_TIMEOUT_MS = (() => {
  const raw = process.env.CHECK_AUDIT_TIMEOUT;
  const DEFAULT_MS = 600 * 1000;
  if (raw === undefined || raw === '') return DEFAULT_MS;
  const seconds = Number(raw);
  if (seconds === 0) return 0;
  if (!Number.isFinite(seconds) || seconds < 0) {
    process.stderr.write(`[check] ignoring invalid audit-timeout "${raw}", using ${DEFAULT_MS / 1000}s\n`);
    return DEFAULT_MS;
  }
  return seconds * 1000;
})();

// Verbose streams raw output, so the in-place live view is disabled there.
const TTY = Boolean(process.stdout.isTTY) && !VERBOSE;

// ── tiny ANSI helpers ──────────────────────────────────────────────────────
const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};
// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is exactly what an ANSI sequence is made of
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const shortRel = (rel) => rel.replace(/^projects\//, '');

function fmtDuration(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

// ── step classification ────────────────────────────────────────────────────
// Map a raw command from a `check` chain onto a stable kind + label so the
// report stays readable regardless of the underlying tool (oxfmt/oxlint/tsc/…).
function classify(cmd) {
  const c = cmd.toLowerCase();
  if (c.includes('vendor-freshness')) return { fatal: false, kind: 'vendor', label: 'vendor-freshness' };
  // Substring match, and the audit kind is HOISTED into a single workspace-level run — so a step
  // named `check:audit-overrides` would be swallowed into the audit slot and never run as itself.
  // `check:overrides` avoids that by not carrying the word; keep it that way when naming new steps.
  if (c.includes('audit')) return { fatal: true, kind: 'audit', label: 'audit' };
  if (c.includes('format:check') || c.includes('oxfmt') || c.includes('prettier'))
    return { fatal: true, kind: 'format', label: 'format' };
  if (c.includes('lint')) return { fatal: true, kind: 'lint', label: 'lint' };
  if (/(^|&|\s)(pnpm\s+)?test(:|\s|$)|vitest|jest|test:unit|test:ci/.test(c))
    return { fatal: true, kind: 'test', label: 'test' };
  if (c.includes('build') || c.includes('nuxt build') || c.includes('tsc'))
    return { fatal: true, kind: 'build', label: 'build' };
  if (c.includes('check-server-start') || c.includes('server-start'))
    return { fatal: true, kind: 'server', label: 'server-start' };
  return { fatal: true, kind: 'other', label: cmd.length > 32 ? `${cmd.slice(0, 29)}…` : cmd };
}

// Rewrite a check-only format/lint command into its auto-fixing variant, so a
// `check` run repairs every fixable finding instead of only reporting it.
function toFixCommand(kind, cmd) {
  if (NO_FIX) return cmd;
  if (kind === 'format') {
    if (/\bformat:check\b/.test(cmd)) return cmd.replace(/\bformat:check\b/, 'format');
    if (/\boxfmt\b/.test(cmd)) return cmd.replace(/\s--check\b/, '');
    if (/\bprettier\b/.test(cmd)) return cmd.replace(/\s--check\b/, ' --write');
    return cmd;
  }
  if (kind === 'lint') {
    if (/\blint:fix\b/.test(cmd) || /--fix\b/.test(cmd)) return cmd;
    if (/\brun\s+lint\b/.test(cmd)) return cmd.replace(/\brun\s+lint\b/, 'run lint:fix');
    if (/\boxlint\b/.test(cmd)) return cmd.replace(/\boxlint\b/, 'oxlint --fix --fix-suggestions');
    return cmd;
  }
  return cmd;
}

// ── metric parsers ─────────────────────────────────────────────────────────
// Sum capture group 1 across every match of `re` (which must carry the `g` flag).
// Returns null when nothing matched, so callers can tell "absent" from "zero".
function sumMatches(clean, re) {
  let total = null;
  for (const m of clean.matchAll(re)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) total = (total ?? 0) + n;
  }
  return total;
}
// A single test step may invoke vitest more than once (`test` is `vitest:unit && vitest`),
// emitting one summary block per run. Sum them all — reading only the first silently
// under-reports every later run, and the test count is the only visible evidence in the
// report that a suite ran at all. Covered by tests/unit/check-script-metrics.spec.ts.
export function parseVitest(out) {
  const clean = stripAnsi(out);
  const passed = sumMatches(clean, /Tests\s+(?:\d+\s+failed[^\n]*?)?(\d+)\s+passed/gi);
  const files = sumMatches(clean, /Test Files\s+(?:\d+\s+failed[^\n]*?)?(\d+)\s+passed/gi);
  const failed = sumMatches(clean, /Tests\s+(\d+)\s+failed/gi);
  if (passed == null && files == null) return null;
  return {
    failed: failed ?? 0,
    files,
    passed,
  };
}
function parseLint(out) {
  const clean = stripAnsi(out);
  const summary = clean.match(/Found\s+(\d+)\s+warnings?(?:\s+and\s+(\d+)\s+errors?)?/i);
  if (summary) return { errors: summary[2] ? Number(summary[2]) : 0, warnings: Number(summary[1]) };
  return {
    errors: (clean.match(/\berror\b/gi) || []).length,
    warnings: (clean.match(/\bwarning\b/g) || []).length,
  };
}

// ── audit (faithful: runs the project's OWN audit command) ──────────────────
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'];

// The audit could not RUN (as opposed to running and finding vulnerabilities).
//
// npm has retired the `/-/npm/v1/security/audits/quick` + `/audits` endpoints (both now 410), and
// every pnpm version — up to and including 11.13.0 — still calls them rather than the working
// `/security/advisories/bulk` endpoint. So `pnpm audit` currently exits non-zero for EVERY project,
// everywhere, with no vulnerability actually reported. Blocking `check` on that is wrong twice over:
// it is not a finding, and no version bump fixes it — it would just paint every `check` red until
// pnpm ships the migration, which trains people to ignore a red audit (the real hazard).
//
// This matches ONLY that infrastructure signature. A genuine vulnerability produces parseable JSON
// counts (handled below, still fatal), and any other non-zero exit stays fatal too — we degrade the
// retired-endpoint case specifically, never "audit failed for some reason".
//
// Why not fall back to `npm audit`? It reaches the working bulk endpoint, but it audits the WRONG
// tree: npm resolves dependencies from package.json alone and ignores both pnpm-lock.yaml and all
// of `pnpm.overrides` — which is exactly where this repo pins vulnerable transitive deps onto
// patched versions. A forced `npm audit` here reports ~18 phantom findings for CVEs the overrides
// already fix in the real install. A misleading red is worse than an honest "could not run"; the
// real fix is upstream pnpm adopting the bulk endpoint, or a pnpm-lock-aware scanner (osv-scanner).
export function isAuditEndpointUnavailable(out) {
  // 1. The retired legacy endpoint (the case this function was written for).
  // The hang guard fired (see AUDIT_TIMEOUT_MS). Checked FIRST: the killed process wrote nothing
  // of its own, so no other branch could possibly recognise it.
  if (/AUDIT_STEP_HUNG/.test(out)) {
    return 'hung';
  }
  if (/ERR_PNPM_AUDIT_BAD_RESPONSE/.test(out) || (/\baudit\b/i.test(out) && /\bretired\b/i.test(out))) {
    return 'retired';
  }

  // 2. The WORKING bulk endpoint failing transiently — added 2026-09-04, after
  // `/-/npm/v1/security/advisories/bulk` answered 503 while `registry.npmjs.org` itself
  // answered 200 in 0.12s. pnpm surfaces that as its own JSON error envelope:
  //
  //   {"error":{"code":23,"message":"The operation was aborted due to timeout"}}
  //
  // The original reasoning covers this case exactly: it is not a finding, and no version bump
  // fixes it — blocking on it paints `check` red for an outage nobody can act on, which is the
  // very training-to-ignore-a-red-audit hazard the comment above warns about. It hit nest-server
  // and nuxt-extensions within the same hour.
  //
  // Deliberately a SIGNATURE match, not "no parseable metadata". The looser rule would also
  // swallow a genuine audit failure whose output merely happens not to parse — and the whole
  // point of the paragraph above is that we degrade specific infrastructure signatures, never
  // "audit failed for some reason". A real finding always yields `advisories`/`metadata`, which
  // the caller has already tried to parse before asking (`!counts`).
  let envelope;
  try {
    envelope = JSON.parse(out.slice(out.indexOf('{')))?.error;
  } catch {
    envelope = undefined;
  }
  if (envelope) {
    // The exception comes FIRST, before the rule it is an exception to — an authentication or
    // authorization refusal is ACTIONABLE (a token, a registry setting) and must stay fatal.
    //
    // This is not hypothetical politeness: a proxy or mirror that rejects the request itself while
    // quoting an upstream status — `403 Forbidden: upstream returned 503` — matches the `5\d\d`
    // signature below on the QUOTED number. Without this guard a wrong credential degrades to
    // "infrastructure, not blocking", the audit silently stops running for good, and nobody is
    // ever told why. Found by nuxt-extensions-f7 by deleting this branch and observing that the
    // 401/403 tests stayed green — they used plain messages, which never reached the signature
    // anyway, so they proved nothing about the branch. The two cases below are the ones that do.
    if (
      /\b(4\d\d)\b/.test(String(envelope.code ?? '')) ||
      /\bunauthor|\bforbidden\b|\bauthentication\b/i.test(String(envelope.message ?? ''))
    ) {
      return false;
    }
    // A 5xx is read from the CODE FIELD ONLY, never from free text. `\b5\d\d\b` against the
    // combined string matches any number 500-599 anywhere in it, and pnpm's own progress prose
    // supplies one: `audited 503 packages` degraded a run that had to block. Found by
    // lt-monorepo-00, who tested this list against cases that must NOT degrade — a direction
    // neither of us had covered, and the one that catches an over-permissive rule.
    //
    // This branch is an ASSUMPTION, not a measurement, and that is worth knowing before somebody
    // treats it as evidence: every outage actually observed carried `code: "pnpm"` or `code: 23`.
    // A numeric 5xx has never been seen here. It stays because it is cheap and unambiguous once
    // the free-text path is closed — not because anything demonstrates it occurs.
    const numericCode = Number(String(envelope.code ?? '').trim());
    if (Number.isInteger(numericCode) && numericCode >= 500 && numericCode <= 599) {
      return 'unreachable';
    }
    const message = `${envelope.code ?? ''} ${envelope.message ?? ''}`;
    // Two families, and the second was missing until lt-monorepo-00 tested against a genuinely
    // dead registry instead of adopting this list: a TIMEOUT (what the npm advisory outage
    // produced) and a REFUSAL. pnpm surfaces the latter as undici's generic `fetch failed`,
    // which none of the timeout signatures match. The list was built from one observed case
    // and never checked against the other — extending it is safe because it is consulted ONLY
    // when an `error` envelope exists, and a real audit report has no `error` key at all, so
    // no advisory whose TITLE happens to contain "timeout" can reach here.
    if (
      /\btimeout\b|\baborted\b|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(message) ||
      /fetch failed|socket hang up|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(message)
    ) {
      return 'unreachable';
    }
  }
  return false;
}

// Run the audit command exactly as the check chain defines it (same scope /
// --prod / --audit-level), only appending --json for the counts. The gate is
// the command's own exit code, so `check` blocks precisely when a bare
// `<auditCmd>` would — never with a narrower scope than the chain. (The old
// hardcoded `--prod` hid devDependency vulns for library packages.)
/**
 * Split a parsed audit report into "assessed" counts and an "ignored" remainder.
 *
 * Exported for `tests/unit/check-script-metrics.spec.ts`: this decides whether a real
 * CRITICAL is rendered as `critical 1` or disappears into `(1 ignored)`, and it is the one
 * piece of the audit accounting that can be wrong in a way nobody notices — the numbers
 * still add up, they just describe the wrong thing.
 *
 * @param parsed - a `pnpm audit --json` / `npm audit --json` report
 * @returns `{ counts, ignored }`; `counts` is null when the report carries no tally
 */
/*
 * A note for whoever compares this with the sibling repos, because the difference is DELIBERATE and
 * currently recorded nowhere else: lt-monorepo and nuxt-extensions solve the same problem the other
 * way round. There, `counts` stays the RAW tally and a separate `countUnlisted()` reports the
 * suppressed remainder beside it; here, `counts` is DERIVED from `advisories` and the remainder is
 * reported as `ignored`. Both are safe against a missing `advisories` key — that is the property
 * that matters — but they are two display designs for one concept, and the labels differ too
 * (`ignored` here, `not listed` in lt-monorepo, `assessed/below threshold` in nuxt-extensions).
 * If you unify them, unify the labels with them; if you change one, this comment is the reason the
 * other looks different, not an oversight to "fix" in passing.
 */
export function splitAuditCounts(parsed) {
  // `metadata.vulnerabilities` is the RAW tally — pnpm deliberately leaves it
  // unfiltered so it can report "(N ignored)" separately. `advisories` is the
  // filtered set, i.e. what `auditConfig.ignoreGhsas` did NOT suppress.
  // Reporting the raw tally would print a green check next to "high 1", which
  // reads as an unaddressed finding and trains the reader to ignore the number.
  const raw = parsed?.metadata?.vulnerabilities ?? null;
  if (raw && parsed?.advisories) {
    const advisories = Object.values(parsed.advisories);
    const counts = { critical: 0, high: 0, info: 0, low: 0, moderate: 0 };
    for (const advisory of advisories) {
      if (advisory?.severity in counts) {
        counts[advisory.severity] += 1;
      }
    }
    return {
      counts,
      ignored: Math.max(0, SEVERITIES.reduce((n, s) => n + (raw[s] || 0), 0) - advisories.length),
    };
  }
  // No `advisories` key at all — npm 7+ emits `auditReportVersion: 2` with a
  // `vulnerabilities` map instead. Deriving the counts from an absent key yields all
  // zeros, so a real, unassessed CRITICAL would render as "critical 0" with the whole
  // tally filed under "ignored": the exact confusion this accounting exists to prevent,
  // produced in reverse. When the split cannot be made, report the raw tally loudly and
  // claim nothing about what was assessed.
  return { counts: raw, ignored: 0 };
}

/**
 * Is a CLEAN audit result indistinguishable from a broken one?
 *
 * The worst failure a gate can have, and the one this answers: when the advisory service is
 * unreachable, pnpm can exit **0** with `advisories: {}` and every count at zero — byte-identical
 * to the report of a genuinely clean repository. There is no error envelope, so
 * `isAuditEndpointUnavailable()` is never even consulted, and the run prints
 *
 *     ✓ audit  critical 0 · high 0 · moderate 0 · low 0 · info 0
 *
 * having verified nothing. A hang is loud and a timeout is catchable; this one reports SAFETY that
 * was never checked, locally and in CI alike. Measured by lt-monorepo-00 against a live outage.
 *
 * This predicate says only "ambiguous", never "broken" — the caller then asks the service itself.
 * A run WITH findings is never ambiguous: findings prove the service answered.
 *
 * @param parsed - a parsed `pnpm audit --json` report
 */
export function isAuditResultAmbiguous(parsed) {
  const advisories = parsed?.advisories;
  const raw = parsed?.metadata?.vulnerabilities;
  if (!advisories || !raw) {
    return false;
  }
  if (Object.keys(advisories).length > 0) {
    return false;
  }
  return SEVERITIES.every((severity) => !raw[severity]);
}

/**
 * Build the bulk-advisory URL for a given registry.
 *
 * Separate and exported so the registry-resolution rule is testable without a network call — the
 * probe below is the only thing standing between a silent registry outage and a green check, and
 * a probe pointed at the wrong host answers confidently about a service nobody asked.
 *
 * Anything that is not an absolute http(s) URL falls back to npmjs.org: `pnpm config get registry`
 * can return an empty string, an error, or a scoped-registry line, and a malformed value must
 * degrade to the previous behaviour rather than produce a URL that cannot be fetched — a probe
 * that always throws would report every clean repo as an outage.
 *
 * @param registry - whatever `pnpm config get registry` produced
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

export { advisoryBulkUrl, configuredRegistry };

/**
 * Ask the advisory service directly whether it is answering.
 *
 * Only called when the report is ambiguous, so a repo with findings never pays for it and a clean
 * repo pays about half a second. Any transport failure counts as unreachable: the question here is
 * "did anybody answer", not "what did they say".
 *
 * It must ask the registry pnpm ACTUALLY USES, not npmjs.org. That was the original form, and it
 * reintroduced the very false-green the probe exists to prevent, one layer down: behind a private
 * registry or a proxy, pnpm fails silently against its own registry while the probe asks npmjs.org,
 * npmjs.org answers, and the run concludes "no outage" and prints a green tick. Found by measuring
 * three real outage modes (502, dead DNS, connection refused) instead of describing them — all
 * three make `pnpm audit --json` exit **0** with a complete, all-zero, entirely healthy-looking
 * report and NO error envelope at all.
 *
 * That measurement narrows what the signature list in `isAuditEndpointUnavailable()` is FOR, and
 * the distinction is worth keeping precise (lt-monorepo-00 corrected an earlier, too-absolute
 * wording of it): the list still covers the retired endpoint, the timeout kill and the hang — all
 * three observed in the wild. It is not redundant. It simply never sees a NETWORK outage, because
 * there is no envelope for it to match. For that class, this probe is the only thing standing
 * between an outage and a green check.
 *
 * Resolving the registry is best-effort: `pnpm config get registry` can fail, and its failure must
 * never take the probe down with it — an unavailable registry setting falls back to npmjs.org,
 * which is what the probe used to do unconditionally. Use the EFFECTIVE value, not `.npmrc`:
 * a scoped registry or `npm_config_registry` in the environment overrides the file.
 *
 * Two costs, both real and both accepted deliberately (raised by nuxt-extensions-f7, who declined
 * to adopt the probe without them being stated):
 *
 * 1. A CLEAN repo is the ambiguous shape, so a healthy run now makes one network call of about half
 *    a second. That is the price of the answer; there is no cheaper discriminator. f7 measured the
 *    obvious candidate and it is dead — an outage and a real audit both take ~825ms, because pnpm
 *    does not treat the advisory call as blocking, and `metadata` is filled from the lockfile even
 *    with no network at all.
 * 2. Working OFFLINE now yields "⚠ vulnerabilities NOT CHECKED" where it used to yield a green
 *    tick. That is the correction, not a regression: offline, nothing WAS checked, and pnpm's
 *    all-zero report is simply wrong. A gate that says "no vulnerabilities" to someone with no
 *    network is the exact failure this whole mechanism exists to remove.
 */
async function advisoryServiceReachable() {
  const registry = configuredRegistry();
  try {
    const response = await fetch(advisoryBulkUrl(registry), {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(8000),
    });
    // A 5xx is the service failing to answer; anything else means it spoke to us.
    return response.status < 500;
  } catch {
    return false;
  }
}

/**
 * Which degradation, if any, does an audit run warrant?
 *
 * Extracted from `runAudit()` so the decision is reachable by a test — it is the point where a
 * "vulnerabilities not checked" can silently become a green tick, and every one of the four answers
 * below was written after a run that got it wrong.
 *
 * The ORDER carries the semantics, and two neighbours are easy to merge by mistake:
 *
 * - `code !== 0 && !counts` must stay AHEAD of the `!counts` case. A non-zero exit whose output
 *   matches no infrastructure signature is a real audit failure and has to keep BLOCKING
 *   (`false` here means "not degraded", which the caller reads as blocking). Folding the two into a
 *   single `!counts` test would turn every such failure into a warning.
 * - `code === 0 && !counts` is the LAST false-green: pnpm reported success and emitted nothing this
 *   gate could read. It never reaches `isAuditResultAmbiguous()` — that predicate needs a parsed
 *   report — so before this branch existed the run printed a green tick and a literal `0` beside it,
 *   having assessed nothing. Note the probe cannot rescue this case the way it rescues the all-zero
 *   one: an answering service says nothing about a tally we never parsed.
 *
 * @returns `'unreachable'` | `'hung'` | `'retired'` | `'unreadable'`, or `false` for "not degraded"
 */
export function resolveAuditDegradation({ code, counts, out, silentOutage }) {
  if (silentOutage) {
    return 'unreachable';
  }
  if (!counts) {
    return code !== 0 ? isAuditEndpointUnavailable(out) : 'unreadable';
  }
  return false;
}

async function runAudit(auditCmd) {
  const cmd = /(^|\s)--json(\s|$)/.test(auditCmd) ? auditCmd : `${auditCmd} --json`;
  const { code, out } = await capture(cmd, ROOT, 0, AUDIT_TIMEOUT_MS);
  let counts = null;
  let ignored = 0;
  try {
    const parsed = JSON.parse(out.slice(out.indexOf('{')));
    // `metadata.vulnerabilities` is the RAW tally — pnpm deliberately leaves it
    // unfiltered so it can report "(N ignored)" separately. `advisories` is the
    // filtered set, i.e. what `auditConfig.ignoreGhsas` did NOT suppress.
    // Reporting the raw tally would print a green check next to "high 1", which
    // reads as an unaddressed finding and trains the reader to ignore the number.
    ({ counts, ignored } = splitAuditCounts(parsed));
  } catch {
    /* fall through to raw reason */
  }

  // An all-zero report with an exit code of 0 is either a clean tree or a silent outage, and the
  // JSON cannot tell them apart (see isAuditResultAmbiguous). Ask the service before printing a
  // green tick that would otherwise assert safety nobody established.
  let silentOutage = false;
  if (code === 0 && counts && SEVERITIES.every((severity) => !counts[severity])) {
    let parsedAgain;
    try {
      parsedAgain = JSON.parse(out.slice(out.indexOf('{')));
    } catch {
      parsedAgain = undefined;
    }
    if (isAuditResultAmbiguous(parsedAgain)) {
      silentOutage = !(await advisoryServiceReachable());
    }
  }

  const total = counts ? SEVERITIES.reduce((n, s) => n + (counts[s] || 0), 0) : 0;
  // Non-zero exit with no parseable counts AND the retired-endpoint signature = infrastructure
  // failure, not a finding. Surface it loudly (degraded) but do not block.
  // Keep WHICH degradation matched, not just that one did — and the reason is about what the
  // READER should do, not about accuracy for its own sake. On `unreachable`, waiting and re-running
  // fixes it. On `retired`, waiting fixes nothing: it needs a pnpm upgrade, so somebody who reads a
  // neutral "could not run" waits forever. A single sentence for both cases takes away the one
  // piece of information that decides the next action — and it was already wrong the first time the
  // second case occurred, when a plain timeout reported "npm retired the audit endpoint".
  const degradedReason = resolveAuditDegradation({ code, counts, out, silentOutage });
  const degraded = Boolean(degradedReason);
  return {
    auditCmd,
    blocking: code !== 0 && !degraded,
    counts,
    degraded,
    degradedReason,
    ignored,
    reason: counts ? null : out,
    total,
  };
}

// ── command runner ─────────────────────────────────────────────────────────
const RUNNING = new Set();

// Best-effort kill of a child's whole process tree (sh → pnpm → vitest →
// fork workers). Killing only the direct child orphans the tree — exactly the
// zombie workers a deadlock leaves behind. Children are collected via pgrep
// and killed leaves-first.
function killTree(child, signal = 'SIGTERM') {
  const pids = [];
  const collect = (pid) => {
    pids.push(pid);
    let out = '';
    try {
      out = execSync(`pgrep -P ${pid}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      /* no children */
    }
    if (out) for (const p of out.split('\n')) collect(Number(p));
  };
  collect(child.pid);
  // Children before parents, without mutating `pids` — the caller still reads it afterwards.
  for (const pid of pids.toReversed()) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

// idleTimeoutMs > 0 arms the no-output watchdog for this child; 0 (the default)
// runs it unwatched. Only callers that KNOW the child streams progress (test
// steps) should pass a timeout — see runGroup.
function capture(cmd, cwd, idleTimeoutMs = 0, absoluteTimeoutMs = 0) {
  return new Promise((settle) => {
    const child = spawn(cmd, { cwd, shell: true });
    RUNNING.add(child);
    let out = '';
    let idleTimer = null;
    let killTimer = null;
    let absoluteTimer = null;
    let watchdogHit = false;
    let absoluteHit = false;
    // Any output resets the watchdog — only complete silence for the full
    // window counts as wedged. Escalate to SIGKILL for processes that ignore
    // SIGTERM (deadlocked event loops usually still honor TERM, but be sure).
    const armWatchdog = () => {
      if (!idleTimeoutMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        watchdogHit = true;
        killTree(child);
        // Track the SIGKILL escalation so a child that honors SIGTERM and exits
        // within the grace window cancels it in done() — otherwise the stray
        // timer could SIGKILL an unrelated process that reused the freed PID.
        killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 5000);
        killTimer.unref();
      }, idleTimeoutMs);
    };
    const onData = (d) => {
      out += d;
      armWatchdog();
      if (VERBOSE) process.stdout.write(d);
    };
    armWatchdog();
    // A SECOND, independent limit — and deliberately not the idle watchdog above.
    //
    // The idle watchdog is scoped to test steps on purpose: build / typecheck / audit legitimately
    // buffer their whole output to the end, so watching for silence would false-kill a slow run
    // that is progressing fine. That reasoning is sound and stays.
    //
    // It leaves one hole, measured by lt-monorepo-00 against a dead registry: `pnpm audit` does not
    // fail there, it HANGS — no output, no exit, no error envelope, so not one of the degraded
    // signatures can fire because every one of them needs the process to have said something. The
    // step then never returns and `check` waits forever, which is worse than any failure: a red run
    // tells you something, a hung one tells you nothing and blocks the terminal.
    //
    // An absolute cap is the right tool for that and the wrong one for slowness: it only ever fires
    // on "never came back", never on "took a while". Set generously (see AUDIT_TIMEOUT_MS).
    if (absoluteTimeoutMs) {
      absoluteTimer = setTimeout(() => {
        absoluteHit = true;
        killTree(child);
        killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 5000);
        killTimer.unref();
      }, absoluteTimeoutMs);
      absoluteTimer.unref();
    }
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const done = (code, extra) => {
      clearTimeout(idleTimer);
      clearTimeout(killTimer);
      clearTimeout(absoluteTimer);
      RUNNING.delete(child);
      if (absoluteHit) {
        const note =
          `[watchdog] step did not finish within ${Math.round(absoluteTimeoutMs / 1000)}s — ` +
          'process tree killed as hung. AUDIT_STEP_HUNG';
        return settle({ code: 1, out: `${out}\n${note}` });
      }
      if (watchdogHit) {
        const note =
          `[watchdog] step produced no output for ${Math.round(idleTimeoutMs / 1000)}s — ` +
          'process tree killed as deadlocked. This is a hang (workers idle at 0% CPU), ' +
          `not a slow run. Re-run the step directly to debug: \`${cmd}\``;
        return settle({ code: 1, out: `${out}\n${note}` });
      }
      settle({ code, out: extra ? `${out}\n${extra}` : out });
    };
    child.on('close', (code) => done(code ?? 1));
    child.on('error', (err) => done(1, err.message));
  });
}
function killAll() {
  for (const child of RUNNING) {
    try {
      killTree(child);
    } catch {
      /* already gone */
    }
  }
}

// ── live multi-line status (one line per running project) ────────────────────
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let liveCount = 0;
let frame = 0;
function drawLive(lines) {
  if (!TTY) return;
  if (liveCount > 0) process.stdout.write(`\x1b[${liveCount}A`);
  for (const l of lines) process.stdout.write(`\r\x1b[K${l}\n`);
  liveCount = lines.length;
}
function statusLines(order, states) {
  frame += 1;
  return order.map((rel) => {
    const s = states.get(rel);
    if (s.failed) return `${C.red('✗')} ${shortRel(rel).padEnd(5)} ${C.red(`${s.failed} FAILED`)}`;
    if (s.done) return `${C.green('✓')} ${shortRel(rel).padEnd(5)} ${C.dim(`done (${fmtDuration(s.total)})`)}`;
    const spin = C.cyan(FRAMES[frame % FRAMES.length]);
    const el = s.stepStart ? C.dim(` (${fmtDuration(Date.now() - s.stepStart)})`) : '';
    return `${spin} ${shortRel(rel).padEnd(5)} ${s.current || 'queued'}${el}`;
  });
}

// ── project discovery + step grouping ────────────────────────────────────────
const IS_ORCHESTRATOR = (script) => !script || script.includes('check.mjs');

// Read the `packages:` globs from pnpm-workspace.yaml (monorepos). A simple
// value-list parse — enough for the globs lt projects use (e.g. `projects/*`).
function workspaceGlobs() {
  let text;
  try {
    text = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  } catch {
    return [];
  }
  const globs = [];
  let inPackages = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '');
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);
      if (m) globs.push(m[1]);
      else if (line.trim() && !/^\s/.test(line)) break; // next top-level key
    }
  }
  return globs;
}

// Expand a workspace glob to concrete directories (handles `dir/*` and literals).
function expandGlob(glob) {
  if (glob.endsWith('/*')) {
    const base = glob.slice(0, -2);
    try {
      return readdirSync(join(ROOT, base), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(base, d.name));
    } catch {
      return [];
    }
  }
  return [glob];
}

function asProject(rel, check) {
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(rel === '.' ? join(ROOT, 'package.json') : join(ROOT, rel, 'package.json'), 'utf8'));
  } catch {
    /* keep defaults */
  }
  return { check, dir: rel === '.' ? ROOT : join(ROOT, rel), name: pkg.name || rel, rel };
}

// Workspace sub-projects and their real check chain; if there are none (a
// single-package repo), fall back to the root project — whose real chain lives
// in `check:raw`, because the root `check` is THIS wrapper.
//
// A member's `check` is frequently THIS wrapper too: the lt starters ship their
// own scripts/check.mjs so they also work standalone (`lt server create`), and
// `lt fullstack init` clones them verbatim into projects/*. Treating that as
// "no real chain" silently dropped EVERY member — the run then fell back to the
// root, whose chain is just `pnpm -r run check`, and reported the whole
// monorepo as one opaque step with "no test step / 0 passed" while the members'
// tests were in fact running, unseen. So resolve a member exactly like the root:
// wrapper `check` means the real chain lives in `check:raw`.
function realChain(pkg) {
  if (!IS_ORCHESTRATOR(pkg.scripts?.check)) return pkg.scripts?.check ?? null;
  return pkg.scripts?.['check:raw'] ?? null;
}

function discoverProjects() {
  const projects = [];
  for (const glob of workspaceGlobs()) {
    for (const rel of expandGlob(glob)) {
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(join(ROOT, rel, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      const chain = realChain(pkg);
      if (chain) projects.push(asProject(rel, chain));
    }
  }
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const rootChain = root.scripts?.['check:raw'] ?? (IS_ORCHESTRATOR(root.scripts?.check) ? null : root.scripts?.check);
  if (projects.length === 0) {
    if (rootChain) projects.push(asProject('.', rootChain));
  } else if (rootChain) {
    // With members present, the root's own chain must not be dropped: beyond
    // install/audit (hoisted later) and the member fan-out (replaced by the
    // member expansion above) it may carry root-ONLY steps — in the assembled
    // monorepo that is `check:workspace` / `check:pin`, which exist precisely
    // for the case where members are present. Strip the fan-out command and
    // keep whatever remains as a root project.
    const ownSteps = rootChain
      .split('&&')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((c) => !/\bpnpm\s+(?:-r|--recursive)\b.*\brun\s+check\b/.test(c));
    if (ownSteps.length) projects.unshift(asProject('.', ownSteps.join(' && ')));
  }
  if (PROJECT_FILTERS.length)
    return projects.filter((p) => PROJECT_FILTERS.some((f) => p.rel.includes(f) || p.name.includes(f)));
  return projects;
}

// One group per project: its ordered, fix-mapped steps. The audit step is
// hoisted to a single workspace-level run; its EXACT command (scope + level +
// package manager) is captured so the run mirrors the chain's own audit.
function buildGroups(projects) {
  let auditCmd = null;
  const groups = projects.map((project) => {
    const steps = [];
    for (const raw of project.check
      .split('&&')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const meta = classify(raw);
      if (meta.kind === 'audit') {
        if (!auditCmd) auditCmd = raw;
        continue;
      }
      steps.push({ ...meta, cmd: toFixCommand(meta.kind, raw), cwd: project.dir });
    }
    return { project, steps };
  });
  return { auditCmd, groups };
}

// A child killed by a signal surfaces through the package manager as a
// "Command failed with exit code 143/137" line (SIGTERM/SIGKILL), NOT as a test
// assertion failure — and the outer shell then reports its own generic exit 1,
// so `code` alone never reveals it. Surface the signal so the reason isn't
// mistaken for a real failure: the usual cause is resource pressure (parallel
// checks/builds swapping the machine) or an external kill.
function signalExitHint(out) {
  const clean = stripAnsi(out);
  // The watchdog also kills via SIGTERM, so pnpm's "exit code 143" ends up in
  // the output — but that path already carries its own [watchdog] note with the
  // correct (deadlock) diagnosis. Don't stack a contradictory "external kill"
  // hint on top of it.
  if (/\[watchdog\]/.test(clean)) return null;
  // Match the package manager's OWN failure line, not an arbitrary "exit code
  // 143" a test happens to log, so a real assertion failure isn't mislabeled.
  const m = clean.match(/Command failed with exit code (137|143)\b/);
  if (!m) return null;
  const sig = m[1] === '143' ? 'SIGTERM' : 'SIGKILL';
  return (
    `[check] step ended via ${sig} (exit ${m[1]}) — the process was killed, not an assertion failure. ` +
    'Usual cause: resource pressure (parallel checks/builds swapping) or an external kill. ' +
    "Re-run this project's check alone to confirm."
  );
}

// ── per-project runner ───────────────────────────────────────────────────────
// Runs a group's steps in order, recording results + live state. Stops early
// when another project already failed (abort.hit).
async function runGroup(group, states, results, abort) {
  const rel = group.project.rel;
  const st = states.get(rel);
  const startedAt = Date.now();
  for (const step of group.steps) {
    if (abort.hit) return;
    st.current = step.label;
    st.stepStart = Date.now();
    if (!TTY) process.stdout.write(`  ${C.dim('→')} ${shortRel(rel)} · ${step.label}\n`);
    // Watchdog only on test steps (see IDLE_TIMEOUT_MS): a test runner streams
    // output continuously, so prolonged silence == deadlocked workers. Other
    // steps buffer their output and must run unwatched.
    const { code, out } = await capture(step.cmd, step.cwd, step.kind === 'test' ? IDLE_TIMEOUT_MS : 0);
    const dur = Date.now() - st.stepStart;
    const r = { dur, kind: step.kind, label: step.label, project: rel };
    if (step.kind === 'test') r.tests = parseVitest(out);
    if (step.kind === 'lint') r.lint = parseLint(out);
    results.push(r);
    if (code !== 0 && step.fatal) {
      st.failed = step.label;
      if (!abort.hit) {
        abort.hit = true;
        const hint = signalExitHint(out);
        abort.failure = {
          out: hint ? `${out}\n${hint}` : out,
          project: rel,
          step: `${shortRel(rel)} · ${step.label}`,
        };
        killAll();
      }
      return;
    }
    if (!TTY)
      process.stdout.write(
        `  ${C.green('✓')} ${shortRel(rel)} · ${step.label}${metricSuffix(r)} ${C.dim(`(${fmtDuration(dur)})`)}\n`,
      );
  }
  st.done = true;
  st.total = Date.now() - startedAt;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const started = Date.now();
  const projects = discoverProjects();
  if (projects.length === 0) {
    console.error(C.red('No workspace projects with a `check` script found.'));
    process.exit(1);
  }
  const { auditCmd, groups } = buildGroups(projects);
  const stepCount = groups.reduce((n, g) => n + g.steps.length, 0) + (auditCmd ? 1 : 0);
  const mode = SEQUENTIAL ? 'sequential' : 'parallel';
  const pkgName = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name;

  console.log(C.bold(`\nRunning checks for ${C.cyan(pkgName)}`));
  console.log(
    C.dim(
      `${projects.length} project(s) · ${stepCount} steps · ${mode} · audit: ${auditCmd ?? 'none'}` +
        `${NO_FIX ? '' : ' · auto-fix format+lint'}` +
        ` · watchdog: ${IDLE_TIMEOUT_MS ? `${fmtDuration(IDLE_TIMEOUT_MS)} (tests)` : 'off'}` +
        `${VERBOSE ? ' · verbose' : ''}\n`,
    ),
  );

  const results = [];

  // Step 0 — single workspace audit (blocking gate, runs before the fan-out).
  // Mirrors the chain's own audit command (scope/level/PM); skipped only when
  // the chain has no audit step.
  if (auditCmd) {
    const t = Date.now();
    if (!TTY) process.stdout.write(`  ${C.dim('→')} audit\n`);
    else drawLive([`${C.cyan(FRAMES[0])} audit`]);
    const audit = await runAudit(auditCmd);
    const dur = Date.now() - t;
    if (audit.blocking) {
      liveCount = 0; // the failure line must survive — nothing may overwrite it
      const summary = audit.counts ? `${audit.total} vuln (${renderVulnLine(audit.counts, audit.ignored)})` : 'failed';
      console.log(`${C.red('✗')} audit  ${C.red(summary)} ${C.dim(`(${fmtDuration(dur)})`)}`);
      return fail(
        `audit (${auditCmd})`,
        audit.counts ? renderVulnLine(audit.counts, audit.ignored) : audit.reason,
        started,
      );
    }
    if (audit.degraded) {
      // Not green: audit could not run. Yellow ⚠, never a green ✓ — a ✓ here would read as
      // "no vulnerabilities", which is a claim we did not verify. Warnings stay visible.
      liveCount = 0;
      console.log(
        `${C.yellow('⚠')} audit  ${C.yellow(
          audit.degradedReason === 'hung'
            ? `did not finish within ${Math.round(AUDIT_TIMEOUT_MS / 1000)}s and was killed — not blocking`
            : audit.degradedReason === 'unreachable'
              ? 'could not run — the npm advisory endpoint is unreachable (timeout/5xx); not blocking'
              : audit.degradedReason === 'unreadable'
                ? 'reported success but no readable tally — nothing was assessed; not blocking'
                : 'could not run — npm retired the audit endpoint pnpm uses; not blocking',
        )} ${C.dim(`(${fmtDuration(dur)})`)}`,
      );
    } else if (!TTY) {
      process.stdout.write(
        `  ${C.green('✓')} audit  ${audit.counts ? renderVulnLine(audit.counts, audit.ignored) : C.dim('0')} ${C.dim(`(${fmtDuration(dur)})`)}\n`,
      );
    }
    // TTY success: NO permanent line — the live status view overwrites the audit
    // row (like every other step), and the result lands in the report twice:
    // the Steps list (entry below) and the Vulnerabilities section.
    results.push({ audit, kind: 'audit' });
    // `warn` so the Steps list agrees with the line above it. Without it a degraded audit printed a
    // yellow warning live, "vulnerabilities NOT CHECKED" in the summary — and a GREEN TICK in the
    // Steps list, because that list hard-codes one per step. Two of the three said "not checked"
    // and the tick said "passed", and the tick is the half people read. Found by
    // nest-server-starter-37, one level above the defect we had both just fixed.
    results.push({ dur, kind: 'step', label: 'audit', project: '.', warn: audit.degraded });
  }

  // Per-project steps — parallel by default, serial with --sequential.
  const order = groups.map((g) => g.project.rel);
  const states = new Map(order.map((rel) => [rel, { current: 'queued' }]));
  const abort = { failure: null, hit: false };
  const ticker = TTY ? setInterval(() => drawLive(statusLines(order, states)), 80) : null;
  if (TTY) drawLive(statusLines(order, states));

  if (SEQUENTIAL) {
    for (const g of groups) {
      await runGroup(g, states, results, abort);
      if (abort.hit) break;
    }
  } else {
    await Promise.all(groups.map((g) => runGroup(g, states, results, abort)));
  }

  if (ticker) clearInterval(ticker);
  if (TTY) drawLive(statusLines(order, states)); // final frame

  if (abort.hit) return fail(abort.failure.step, abort.failure.out, started);

  report(started, results);
  process.exit(0);
}

// ── rendering helpers ─────────────────────────────────────────────────────────
function renderVulnLine(counts, ignored = 0) {
  const line = SEVERITIES.map((s) => {
    const n = counts[s] || 0;
    const txt = `${s} ${n}`;
    if (n > 0 && (s === 'critical' || s === 'high')) return C.red(txt);
    return n > 0 ? C.yellow(txt) : C.dim(txt);
  }).join(C.dim(' · '));
  // Never hide a suppression: a silently filtered advisory is indistinguishable
  // from one that never existed, which is exactly what makes `ignoreGhsas` risky.
  return ignored > 0 ? `${line}${C.dim(' · ')}${C.yellow(`${ignored} ignored`)}` : line;
}

function metricSuffix(r) {
  if (r.kind === 'test' && r.tests?.passed != null) {
    const failed = r.tests.failed ? C.red(` / ${r.tests.failed} failed`) : '';
    return `  ${C.dim(`${r.tests.passed} passed${r.tests.files != null ? ` / ${r.tests.files} files` : ''}`)}${failed}`;
  }
  if (r.kind === 'lint' && r.lint) {
    return r.lint.warnings > 0
      ? `  ${C.yellow(`${r.lint.warnings} warning${r.lint.warnings === 1 ? '' : 's'}`)}`
      : `  ${C.dim('clean')}`;
  }
  return '';
}

function fail(stepLabel, reason, started) {
  console.log(`\n${C.red(`──── reason · ${stepLabel} ────`)}`);
  console.log(stripAnsi(String(reason)).trimEnd().split('\n').slice(-40).join('\n'));
  console.log(C.red('────────────────────────────────────────\n'));
  console.log(C.bold(C.red(`✗ Check FAILED at step "${stepLabel}" after ${fmtDuration(Date.now() - started)}.`)));
  console.log(C.dim('Re-run with --verbose for the full output of every step.'));
  process.exit(1);
}

function report(started, results) {
  const audit = results.find((r) => r.kind === 'audit')?.audit;
  const tests = results.filter((r) => r.kind === 'test');
  const unit = tests.find((r) => r.project?.includes('app'))?.tests;
  const api = tests.find((r) => r.project?.includes('api'))?.tests;
  const totalPassed = tests.reduce((n, r) => n + (r.tests?.passed || 0), 0);

  const bar = '═'.repeat(52);
  console.log(`\n${C.green(bar)}`);
  console.log(C.bold(`  ${C.green('✓ Check PASSED')}  ${C.dim(`(${fmtDuration(Date.now() - started)})`)}`));
  console.log(C.green(bar));

  console.log(`\n${C.bold('Steps')}`);
  const steps = results.filter((x) => x.kind !== 'audit');
  // Group by project when more than one is involved: workspace-level steps
  // (hoisted install/audit, root-only checks) under "monorepo", then one block
  // per member. Steps within a project run sequentially, so per-group order is
  // chain order. A single-project run keeps the flat list — a header is noise.
  const stepGroups = [...new Set(steps.map((r) => r.project))].sort((a, b) =>
    a === '.' ? -1 : b === '.' ? 1 : shortRel(a).localeCompare(shortRel(b)),
  );
  if (stepGroups.length > 1) {
    for (const project of stepGroups) {
      console.log(`  ${C.bold(project === '.' ? 'monorepo' : shortRel(project))}`);
      for (const r of steps.filter((x) => x.project === project)) {
        console.log(
          `    ${r.warn ? C.yellow('⚠') : C.green('✓')} ${r.label.padEnd(24)}${metricSuffix(r) || '  '} ${C.dim(`(${fmtDuration(r.dur)})`)}`,
        );
      }
    }
  } else {
    for (const r of steps) {
      console.log(
        `  ${r.warn ? C.yellow('⚠') : C.green('✓')} ${`${shortRel(r.project)} · ${r.label}`.padEnd(26)}${metricSuffix(r) || '  '} ${C.dim(`(${fmtDuration(r.dur)})`)}`,
      );
    }
  }

  console.log(`\n${C.bold('Vulnerabilities')} ${C.dim(audit ? `(${audit.auditCmd})` : '(no audit step)')}`);
  console.log(
    `  ${
      audit?.counts
        ? renderVulnLine(audit.counts, audit.ignored)
        : audit?.degraded
          ? C.yellow(
              audit.degradedReason === 'hung'
                ? 'audit HUNG and was killed (the registry never answered) — vulnerabilities NOT CHECKED'
                : audit.degradedReason === 'unreachable'
                  ? 'audit could not run (the npm advisory service was unreachable) — vulnerabilities NOT CHECKED'
                  : audit.degradedReason === 'unreadable'
                    ? 'audit exited 0 but emitted no readable tally — vulnerabilities NOT CHECKED'
                    : 'audit could not run (npm retired the endpoint pnpm uses) — vulnerabilities NOT CHECKED',
            )
          : C.dim(audit ? 'counts unavailable' : '—')
    }`,
  );

  console.log(`\n${C.bold('Tests')}`);
  if (unit || api) {
    // Monorepo with app and/or api projects → the canonical area breakdown.
    console.log(`  ${'Unit (app)'.padEnd(18)}${unit?.passed != null ? `${unit.passed} passed` : C.dim('—')}`);
    console.log(`  ${'API (api)'.padEnd(18)}${api?.passed != null ? `${api.passed} passed` : C.dim('—')}`);
    console.log(`  ${'Playwright'.padEnd(18)}${C.dim('— (run via `lt dev test` / CI)')}`);
  } else {
    // Single-package repo → one line per test-bearing project.
    for (const r of tests)
      console.log(
        `  ${shortRel(r.project).padEnd(18)}${r.tests?.passed != null ? `${r.tests.passed} passed` : C.dim('—')}`,
      );
    if (tests.length === 0) console.log(`  ${C.dim('no test step')}`);
  }
  console.log(`  ${C.bold('Total'.padEnd(18))}${C.bold(`${totalPassed} passed`)}`);

  console.log(`\n${C.green('All checks passed.')}\n`);
}

// Run the pipeline only when invoked as a script. Importing this module (the metric parsers are
// unit-tested in tests/unit/check-script-metrics.spec.ts) must not spawn a check run.
const INVOKED_AS_SCRIPT = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (INVOKED_AS_SCRIPT) {
  main().catch((err) => {
    console.error(C.red(`\ncheck.mjs crashed: ${err?.stack || err}`));
    process.exit(1);
  });
}
