import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(join(__dirname, '..', '..', 'scripts', 'check-mutations.mjs'), 'utf8');

/**
 * The regression-evidence gate must END without cutting its own output.
 *
 * On a pipe — every CI runner — Node writes stdout asynchronously, and `process.exit()` drops what is still queued.
 * The parallel path writes every verdict block at the very end, so a slow log collector loses the tail: measured with
 * 409 blocks and a reader that starts one second late, 16 of 410 lines arrived.
 *
 * @regression   12.1.0 publish — the evidence job exited 1 after printing 359 of 407 verdict blocks and no summary,
 *   so the red gate (issue #653) named no failing mutation; a manual run on develop repeated it with 361 of 409.
 * @seen-failing Replace `process.exitCode = failed.length ? 1 : 0;` with `process.exit(failed.length ? 1 : 0);` in
 *   scripts/check-mutations.mjs — registered as mutation `mutation-gate-exit-drops-verdicts` in
 *   tests/regression-mutations.json.
 */
describe('check-mutations — the gate keeps its whole report on a pipe', () => {
  it('ends through process.exitCode after the summary, never process.exit()', () => {
    // The LAST mention is the summary line; earlier ones are comments.
    const afterSummary = SOURCE.slice(
      SOURCE.lastIndexOf('mutations confirmed'),
      SOURCE.indexOf('export function isSameCliEntry'),
    );

    expect(afterSummary).toContain('process.exitCode = failed.length ? 1 : 0;');
    expect(afterSummary).not.toMatch(/^\s*process\.exit\(/m);
  });

  it('reports a crash the same way', () => {
    const crashHandler = SOURCE.slice(SOURCE.indexOf('check-mutations.mjs crashed'));

    expect(crashHandler).toContain('process.exitCode = 1;');
    expect(crashHandler).not.toMatch(/^\s*process\.exit\(/m);
  });
});
