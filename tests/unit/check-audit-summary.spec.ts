/**
 * Unit Tests: the "Vulnerabilities" line of the `scripts/check.mjs` summary.
 *
 * That line is where people look after a run. It must never print a clean tally for an audit that
 * did not actually reach the advisory service — the case the whole degraded path exists for.
 */
import { stripVTControlCharacters as strip } from 'node:util';
import { describe, expect, it } from 'vitest';

import { renderAuditSummary } from '../../scripts/check.mjs';

const ZERO = { critical: 0, high: 0, info: 0, low: 0, moderate: 0 };

describe('check.mjs Vulnerabilities summary line', () => {
  /**
   * @regression   11.42.x — the summary tested `audit.counts` before `audit.degraded`. A silent
   *   outage (exit 0, all-zero JSON, advisory service unreachable) keeps `counts` set to exactly the
   *   shape a clean tree produces, so the step line showed a warning while the summary printed
   *   "critical 0 · high 0 · …" — a clean bill of health nobody established. Ported from
   *   nest-server-starter, whose check.mjs tests `degraded` first.
   * @seen-failing Test `audit?.counts` before `audit?.degraded` in renderAuditSummary() in
   *   scripts/check.mjs — registered as mutation `check-audit-summary-counts-before-degraded` in
   *   tests/regression-mutations.json.
   */
  it('reports a silent outage as NOT CHECKED although an all-zero tally was parsed', () => {
    const line = strip(renderAuditSummary({ counts: ZERO, degraded: true, degradedReason: 'unreachable', ignored: 0 }));

    expect(line).toContain('NOT CHECKED');
    expect(line).not.toContain('critical 0');
  });

  it('renders the tally of a healthy run', () => {
    // The refusal case for the test above: a summary that always says NOT CHECKED would pass it.
    const line = strip(renderAuditSummary({ counts: { ...ZERO, high: 1 }, degraded: false, ignored: 2 }));

    expect(line).toContain('high 1');
    expect(line).toContain('2 ignored');
  });

  it.each(['hung', 'unreachable', 'unreadable', 'retired'])('names the degradation reason %s', (reason) => {
    const line = strip(renderAuditSummary({ counts: null, degraded: true, degradedReason: reason, ignored: 0 }));

    expect(line).toContain('NOT CHECKED');
  });

  it('says so when there was no audit step at all', () => {
    expect(strip(renderAuditSummary(undefined))).toBe('—');
  });
});
