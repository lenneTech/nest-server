/**
 * Unit Tests: `scripts/check.mjs` metric parsing.
 *
 * `parseVitest()` turns a test step's captured stdout into the counts the check report prints.
 * Since `test` is `vitest:unit && vitest`, a single step emits TWO vitest summary blocks — and
 * the printed test count is the only evidence in the report that a suite ran at all. A parser
 * that reads just the first block reports a green check while silently dropping the e2e suite.
 *
 * These fixtures are verbatim vitest summary shapes (non-TTY, ANSI-stripped by the parser).
 */
import { describe, expect, it } from 'vitest';

import {
  isAuditEndpointUnavailable,
  isAuditResultAmbiguous,
  advisoryBulkUrl,
  parseVitest,
  resolveAuditDegradation,
  splitAuditCounts,
} from '../../scripts/check.mjs';

const UNIT_RUN = ' Test Files  16 passed (16)\n      Tests  646 passed (646)\n';
const E2E_RUN = ' Test Files  51 passed (51)\n      Tests  1380 passed (1380)\n';
const DURATION = '   Duration  5.25s (transform 5.96s, setup 0ms, import 34.08s, tests 5.88s, environment 1ms)\n';

describe('check.mjs: parseVitest', () => {
  it('should sum the summary blocks of every vitest run in one step', () => {
    expect(parseVitest(UNIT_RUN + DURATION + E2E_RUN + DURATION)).toEqual({
      failed: 0,
      files: 67,
      passed: 2026,
    });
  });

  it('should read a single run', () => {
    expect(parseVitest(UNIT_RUN)).toEqual({ failed: 0, files: 16, passed: 646 });
  });

  it('should sum failures across runs and keep the passed counts', () => {
    const failingE2e = ' Test Files  1 failed | 50 passed (51)\n      Tests  2 failed | 1378 passed (1380)\n';
    expect(parseVitest(UNIT_RUN + failingE2e)).toEqual({ failed: 2, files: 66, passed: 2024 });
  });

  it('should read the passed count past interleaved todo/skipped segments', () => {
    expect(parseVitest('      Tests  1 failed | 2 todo | 643 passed (646)\n')).toMatchObject({
      failed: 1,
      passed: 643,
    });
  });

  it('should strip ANSI colour codes before matching', () => {
    expect(
      parseVitest(` Test Files  \x1b[1m\x1b[32m16 passed\x1b[0m (16)\n      Tests  \x1b[32m646 passed\x1b[0m (646)\n`),
    ).toEqual({ failed: 0, files: 16, passed: 646 });
  });

  // The `Duration` line contains a lowercase "tests 5.88s"; the regexes are case-insensitive, so
  // a sloppy pattern would pick a number out of it.
  it('should not read counts out of the duration line', () => {
    expect(parseVitest(DURATION)).toBeNull();
  });

  // No "N passed" anywhere → no metrics to show, rather than a misleading zero.
  it('should return null when a run reports no passing tests', () => {
    expect(parseVitest(' Test Files  1 failed (1)\n      Tests  3 failed (3)\n')).toBeNull();
  });

  it('should return null for output without a summary block', () => {
    expect(parseVitest('')).toBeNull();
    expect(parseVitest('some unrelated build output\n')).toBeNull();
  });

  // Importing check.mjs must not kick off a check run — `main()` runs only when
  // INVOKED_AS_SCRIPT (`resolve(process.argv[1]) === check.mjs`). Under vitest, argv[1] is the
  // runner, so the guard is false and the top-of-file import above did not spawn a check run
  // (a spawned run would have hung/failed this file). Assert the guard's premise directly, not
  // just that the export exists.
  it('should not execute the pipeline on import (argv guard holds under vitest)', () => {
    const runner = process.argv[1] ?? '';
    expect(runner).not.toMatch(/check\.mjs$/);
    expect(typeof parseVitest).toBe('function');
  });
});

/**
 * @regression   11.39.x — the counts were derived from `parsed.advisories` unconditionally.
 *   npm 7+ emits `auditReportVersion: 2` with a `vulnerabilities` map and NO `advisories`
 *   key at all, so every severity came out 0 and the entire tally was filed under
 *   "ignored" — a real, unassessed CRITICAL rendered as `critical 0 (1 ignored)`. That is
 *   the exact confusion this accounting exists to prevent, produced in reverse.
 * @seen-failing Registered as mutation `check-audit-counts-assume-advisories` in
 *   tests/regression-mutations.json (restore the unconditional derivation).
 */
describe('check.mjs: splitAuditCounts', () => {
  // pnpm's shape: a raw tally in `metadata`, plus the post-suppression set in `advisories`.
  const pnpmReport = (advisories: Record<string, { severity: string }>, raw: Record<string, number>) => ({
    advisories,
    metadata: { vulnerabilities: raw },
  });

  it('counts the assessed advisories and files the remainder as ignored', () => {
    const result = splitAuditCounts(
      pnpmReport({ 1: { severity: 'high' } }, { critical: 0, high: 2, info: 0, low: 0, moderate: 0 }),
    );
    expect(result.counts).toEqual({ critical: 0, high: 1, info: 0, low: 0, moderate: 0 });
    // Two in the raw tally, one still listed → exactly one was suppressed.
    expect(result.ignored).toBe(1);
  });

  it('reports nothing ignored when every finding is still listed', () => {
    const result = splitAuditCounts(
      pnpmReport({ 1: { severity: 'critical' } }, { critical: 1, high: 0, info: 0, low: 0, moderate: 0 }),
    );
    expect(result.counts).toEqual({ critical: 1, high: 0, info: 0, low: 0, moderate: 0 });
    expect(result.ignored).toBe(0);
  });

  it('keeps an empty advisories object on the assessed path', () => {
    // `advisories: {}` is what pnpm emits for a clean tree. It is an OBJECT, so it must take
    // the assessed branch — treating it as "absent" would report the raw tally as unassessed.
    const result = splitAuditCounts(pnpmReport({}, { critical: 0, high: 0, info: 0, low: 0, moderate: 0 }));
    expect(result.counts).toEqual({ critical: 0, high: 0, info: 0, low: 0, moderate: 0 });
    expect(result.ignored).toBe(0);
  });

  it('reports the RAW tally when the report has no advisories key at all', () => {
    // npm's auditReportVersion 2. The defect: deriving from an absent key yielded
    // `critical 0, ignored 1` for a live CRITICAL nobody had assessed.
    const result = splitAuditCounts({
      auditReportVersion: 2,
      metadata: { vulnerabilities: { critical: 1, high: 0, info: 0, low: 0, moderate: 0 } },
      vulnerabilities: { 'some-pkg': { severity: 'critical' } },
    });
    expect(result.counts).toEqual({ critical: 1, high: 0, info: 0, low: 0, moderate: 0 });
    expect(result.ignored).toBe(0);
  });

  it('returns null counts when the report carries no tally', () => {
    // The caller renders `reason` (the raw output) instead of a green check, so "no numbers"
    // must stay distinguishable from "all zeros".
    expect(splitAuditCounts({}).counts).toBeNull();
    expect(splitAuditCounts(undefined).counts).toBeNull();
  });
});

/**
 * @regression   11.39.x — the degraded-audit path matched ONLY the retired legacy endpoint. When
 *   the WORKING bulk endpoint answered 503 (registry itself fine, 200 in 0.12s), pnpm emitted its
 *   own error envelope `{"error":{"code":23,"message":"The operation was aborted due to timeout"}}`
 *   and `check` hard-failed at its first step — for an outage nobody can act on, in two base repos
 *   within the same hour. That is the exact "trains people to ignore a red audit" hazard the
 *   surrounding comment argues against, produced by the guard meant to prevent it.
 * @seen-failing Two registered mutations, because the branch has two independent failure modes:
 *   `check-audit-degrade-retired-only` (restore the retired-only match — 3 tests go red) and
 *   `check-audit-degrades-auth-refusal` (delete the auth guard — exactly the 2 mixed-message
 *   cases go red, while the plain 401/403 ones stay green, which is how that gap was found), and
 *   `check-audit-hang-unrecognised` (drop the AUDIT_STEP_HUNG branch — a hung audit then falls
 *   through every signature, because a killed process wrote nothing to match on).
 *   All in tests/regression-mutations.json.
 */
describe('check.mjs: isAuditEndpointUnavailable', () => {
  const envelope = (code: unknown, message: string) => JSON.stringify({ error: { code, message } });

  it('degrades a HUNG audit, and keeps it distinguishable', () => {
    // The hang guard's marker. Checked before every signature, because a killed process wrote
    // nothing of its own — no envelope, no message — so no other branch could recognise it.
    // The REASON is separate from `unreachable` on purpose: "unreachable" means wait and re-run,
    // "hung" means look locally. A single "could not check" would bury the actionable case under
    // the unactionable one.
    const killed =
      'partial output\n[watchdog] step did not finish within 600s — process tree killed as hung. AUDIT_STEP_HUNG';
    expect(isAuditEndpointUnavailable(killed)).toBe('hung');
  });

  it('degrades the retired legacy endpoint, and says so', () => {
    expect(isAuditEndpointUnavailable('ERR_PNPM_AUDIT_BAD_RESPONSE')).toBe('retired');
    expect(isAuditEndpointUnavailable('the audit endpoint has been retired')).toBe('retired');
  });

  it.each([
    ['abort/timeout', envelope(23, 'The operation was aborted due to timeout')],
    ['5xx', envelope(503, 'Service Unavailable')],
    ['ETIMEDOUT', envelope('ETIMEDOUT', 'request to registry.npmjs.org failed')],
  ])('degrades a transport TIMEOUT of the working endpoint (%s)', (_name, out) => {
    // The REASON matters, not just the verdict: the report prints a different sentence for each,
    // and the first version printed "npm retired the audit endpoint" for a plain timeout — a
    // message asserting something the run had not established.
    expect(isAuditEndpointUnavailable(out)).toBe('unreachable');
  });

  it.each([
    ['fetch failed (undici generic)', envelope('pnpm', 'fetch failed')],
    ['socket hang up', envelope('pnpm', 'socket hang up')],
    ['ECONNREFUSED', envelope('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:1')],
    ['EHOSTUNREACH', envelope('EHOSTUNREACH', 'no route to host')],
  ])('degrades a connection REFUSAL as well (%s)', (_name, out) => {
    // The second family, and it was missing. The signature list grew out of the one outage that
    // was observed (a timeout) and had never been tried against a refused connection — pnpm
    // reports that as undici's generic `fetch failed`, which matches none of the timeout
    // signatures. Found by lt-monorepo-00 pointing `pnpm audit` at a dead registry rather than
    // adopting the list on trust.
    expect(isAuditEndpointUnavailable(out)).toBe('unreachable');
  });

  it('does NOT degrade a real finding', () => {
    // The case that must always block. A finding yields parseable counts, never an error envelope.
    const report = JSON.stringify({
      advisories: { 1: { severity: 'high' } },
      metadata: { vulnerabilities: { high: 1 } },
    });
    expect(isAuditEndpointUnavailable(report)).toBe(false);
  });

  it.each([
    ['an unrecognised failure', 'Something else went wrong'],
    ['an auth error', envelope(401, 'Unauthorized')],
    ['a permission error', envelope(403, 'Forbidden')],
  ])('does NOT degrade %s', (_name, out) => {
    // The negative controls that keep this a SIGNATURE match rather than "audit failed for some
    // reason". A 401/403 is actionable — a token or a registry setting — so it must stay fatal.
    expect(isAuditEndpointUnavailable(out)).toBe(false);
  });

  it.each([
    ['a proxy quoting an upstream 5xx', envelope(403, 'Forbidden: upstream returned 503')],
    ['proxy auth quoting an upstream 5xx', envelope(407, 'Proxy Authentication Required (504 upstream)')],
  ])('does NOT degrade %s — the actionable half of a mixed message wins', (_name, out) => {
    // THE case the three plain 401/403 cases above do not cover, and the reason the auth guard
    // exists at all. A proxy or mirror that refuses the request itself while quoting an upstream
    // status matches `\b5\d\d\b` on the QUOTED number. Degrading it would turn a wrong token into
    // "infrastructure, not blocking": the audit silently stops running for good and nobody is
    // told why. Delete the auth branch and these two go red while the plain ones stay green —
    // which is exactly how the gap was found (credit: nuxt-extensions-f7).
    expect(isAuditEndpointUnavailable(out)).toBe(false);
  });
});

/**
 * @regression   11.39.x — with the advisory service unreachable, pnpm can exit **0** with
 *   `advisories: {}` and every count at zero: byte-identical to a genuinely clean repo, and with
 *   no error envelope, so the degraded path was never even consulted. The run printed
 *   `✓ audit  critical 0 · high 0 · …` and PASSED, locally and in CI, having verified nothing.
 *   A hang is loud and a timeout is catchable; this reported SAFETY that was never established —
 *   the worst shape a security gate can take. Measured against a live outage by lt-monorepo-00.
 * @seen-failing Registered as mutation `check-audit-ambiguity-blind` in
 *   tests/regression-mutations.json (make the predicate always answer false, i.e. never ask the
 *   service — the two ambiguous cases go red while the ones with findings stay green).
 */
describe('check.mjs: isAuditResultAmbiguous', () => {
  const report = (advisories: Record<string, unknown>, vulnerabilities: Record<string, number>) => ({
    advisories,
    metadata: { vulnerabilities },
  });
  const ZERO = { critical: 0, high: 0, info: 0, low: 0, moderate: 0 };

  it('flags the shape a clean repo and a dead service share', () => {
    expect(isAuditResultAmbiguous(report({}, ZERO))).toBe(true);
  });

  it('is not fooled by a missing advisories key', () => {
    // That shape belongs to npm's auditReportVersion 2 and is handled elsewhere; treating it as
    // ambiguous would probe the network on every npm-style report.
    expect(isAuditResultAmbiguous({ metadata: { vulnerabilities: ZERO } })).toBe(false);
    expect(isAuditResultAmbiguous(undefined)).toBe(false);
  });

  it.each([
    ['listed advisories', report({ 1: { severity: 'high' } }, { ...ZERO, high: 1 })],
    ['non-zero counts only', report({}, { ...ZERO, high: 2 })],
  ])('is NOT ambiguous when there are findings (%s)', (_name, parsed) => {
    // The negative control that keeps the probe cheap AND keeps the predicate honest: findings
    // PROVE the service answered, so there is nothing to ask and nothing to doubt.
    expect(isAuditResultAmbiguous(parsed)).toBe(false);
  });
});

/**
 * @regression   11.39.x — an audit that exited 0 while emitting nothing this gate could parse
 *   printed a GREEN tick with a literal `0` beside it. `counts` was null, so the all-zero
 *   ambiguity probe was never entered (it needs a parsed report), and `degradedReason` stayed
 *   `false` because that expression only considered a NON-zero exit. The Vulnerabilities section
 *   said "counts unavailable" while the step line said the audit passed — and the tick is the half
 *   people read. Found at the edge of a question from document-analyzer-13, relayed by
 *   nest-server-starter-37, about whether the ambiguity guard covers a plausible-looking report.
 * @seen-failing Replace the `code === 0 ? ... : 'unreadable'` branch of resolveAuditDegradation()
 *   in scripts/check.mjs with a bare `isAuditEndpointUnavailable(out)` — registered as mutation
 *   `check-audit-zero-exit-no-tally` in tests/regression-mutations.json.
 */
describe('check.mjs: resolveAuditDegradation', () => {
  const COUNTS = { critical: 0, high: 0, info: 0, low: 0, moderate: 0 };

  it('degrades a code-0 run that produced no readable tally', () => {
    // The false-green this branch exists for: pnpm claims success, the gate learns nothing.
    expect(resolveAuditDegradation({ code: 0, counts: null, out: 'up to date', silentOutage: false })).toBe(
      'unreadable',
    );
  });

  it('keeps a genuine failure BLOCKING rather than degrading it', () => {
    // The neighbour that must not be merged in: non-zero exit, no infrastructure signature.
    // `false` means "not degraded", which the caller reads as blocking. Collapsing the two
    // branches into one `!counts` test would turn every real audit failure into a warning.
    expect(
      resolveAuditDegradation({ code: 1, counts: null, out: 'something went wrong', silentOutage: false }),
    ).toBe(false);
  });

  it('still recognises the infrastructure signatures on a non-zero exit', () => {
    expect(resolveAuditDegradation({ code: 1, counts: null, out: 'AUDIT_STEP_HUNG', silentOutage: false })).toBe(
      'hung',
    );
    expect(
      resolveAuditDegradation({ code: 1, counts: null, out: 'ERR_PNPM_AUDIT_BAD_RESPONSE', silentOutage: false }),
    ).toBe('retired');
  });

  it('lets the silent-outage probe win over everything', () => {
    // The probe already asked the service; its answer outranks the exit code.
    expect(resolveAuditDegradation({ code: 0, counts: COUNTS, out: '{}', silentOutage: true })).toBe('unreachable');
  });

  it('does not degrade a run that produced counts', () => {
    expect(resolveAuditDegradation({ code: 0, counts: COUNTS, out: '{}', silentOutage: false })).toBe(false);
  });
});

/**
 * @regression   11.40.0 — the 5xx signature was matched with `\b5\d\d\b` against `code + message`
 *   joined, so ANY number 500-599 anywhere in the envelope degraded the run. pnpm's own progress
 *   prose supplies one (`audited 503 packages`), which turned a run that had to BLOCK into a
 *   yellow "not blocking" warning. Found by lt-monorepo-00 by testing the signature list against
 *   cases that must NOT degrade — the direction neither repo had covered, and the only one that
 *   catches a rule that has grown too permissive.
 * @seen-failing Put `|\b5\d\d\b` back into the free-text signature alternation in
 *   scripts/check.mjs — registered as mutation `check-audit-5xx-from-free-text` in
 *   tests/regression-mutations.json.
 */
describe('check.mjs: 5xx is read from the code field, not from prose', () => {
  const envelope = (code: unknown, message: string) => JSON.stringify({ error: { code, message } });

  it('does NOT degrade when a 5xx-looking number appears in the message', () => {
    // `false` means "not degraded", which the caller reads as BLOCKING — the whole point.
    expect(isAuditEndpointUnavailable(envelope('pnpm', 'audited 503 packages'))).toBe(false);
  });

  it('still degrades on a genuine 5xx in the code field, as a number or a numeric string', () => {
    expect(isAuditEndpointUnavailable(envelope(503, 'Service Unavailable'))).toBe('unreachable');
    expect(isAuditEndpointUnavailable(envelope('503', 'gateway'))).toBe('unreachable');
  });

  it('keeps the two OBSERVED outage shapes degrading', () => {
    // Neither carries a numeric 5xx — which is why the numeric branch above is an assumption and
    // these two are the measurements. If a refactor keeps only one family, keep this one.
    expect(isAuditEndpointUnavailable(envelope(23, 'The operation was aborted due to timeout'))).toBe('unreachable');
    expect(isAuditEndpointUnavailable(envelope('pnpm', 'fetch failed'))).toBe('unreachable');
  });

  it('keeps an auth refusal fatal even when its text carries a transient-sounding word', () => {
    // The exception that must stay AHEAD of the signature match: a wrong token is actionable and
    // must never degrade into a permanent, ignorable warning.
    expect(isAuditEndpointUnavailable(envelope(401, 'Unauthorized: session timeout'))).toBe(false);
    expect(isAuditEndpointUnavailable(envelope(403, 'Forbidden, request aborted'))).toBe(false);
  });
});

/**
 * @regression   11.40.0 — the reachability probe asked `registry.npmjs.org` unconditionally while
 *   pnpm audits against the CONFIGURED registry. Behind a private registry or a proxy that meant:
 *   pnpm fails silently against its own registry, the probe asks npmjs.org, npmjs.org answers, and
 *   the run concludes "no outage" and prints a green tick — the exact false-green the probe was
 *   built to prevent, one layer down. Found by MEASURING three real outage modes (502, dead DNS,
 *   connection refused) rather than describing them: all three make `pnpm audit --json` exit 0 with
 *   a complete, all-zero, healthy-looking report and no error envelope at all, which is also why
 *   the signature list cannot be the defence here.
 * @seen-failing Make advisoryBulkUrl() ignore its argument and always return the npmjs.org URL in
 *   scripts/check.mjs — registered as mutation `check-probe-ignores-registry` in
 *   tests/regression-mutations.json.
 */
describe('check.mjs: advisoryBulkUrl', () => {
  it('asks the registry pnpm actually uses', () => {
    expect(advisoryBulkUrl('https://npm.internal.example/')).toBe(
      'https://npm.internal.example/-/npm/v1/security/advisories/bulk',
    );
  });

  it('tolerates a missing trailing slash and surrounding whitespace', () => {
    // `pnpm config get registry` returns a trailing newline, and not every registry carries a slash.
    expect(advisoryBulkUrl('  https://npm.internal.example  ')).toBe(
      'https://npm.internal.example/-/npm/v1/security/advisories/bulk',
    );
  });

  it.each([['', 'empty'], ['undefined', 'the literal pnpm prints when unset'], ['not-a-url', 'garbage']])(
    'falls back to npmjs.org for %s (%s)',
    (value) => {
      // A malformed setting must degrade to the PREVIOUS behaviour. A probe that throws would
      // report every clean repo as an outage — worse than the bug being fixed.
      expect(advisoryBulkUrl(value)).toBe('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk');
    },
  );

  it('falls back when the value is not a string at all', () => {
    expect(advisoryBulkUrl(undefined as unknown as string)).toBe(
      'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
    );
  });
});
