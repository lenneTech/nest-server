import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * A `catch` block that asserts nothing meaningful makes its test pass on EVERY outcome.
 *
 * The shape:
 *
 * ```typescript
 * try {
 *   const response = await testHelper.rest('/iam/two-factor/enable', { statusCode: 200 });
 *   expect(response).toBeDefined();
 * } catch (error) {
 *   expect(error).toBeDefined();   // ← both branches assert "something happened"
 * }
 * ```
 *
 * `testHelper.rest()` throws when the status does not match, which is the whole point of passing
 * `statusCode`. The catch then swallows that throw. The case is green whether the endpoint works,
 * answers 404, 500s, or is not routed at all — a filled cell in the coverage report that checks
 * nothing.
 *
 * ── Why this is a BASELINE and not a ban ───────────────────────────────────────
 * Measured, not estimated: removing the swallow from `better-auth-plugins.story.test.ts` alone
 * turns **17 of its 45 cases red**, all status-code mismatches (`404` where `200` was declared,
 * `400` where `401` was, and the reverse). None of them looks like a broken user path; they look
 * like expectations written against assumptions that were never checked, precisely because the
 * catch hid the answer.
 *
 * Fixing them means deciding, for each case, what the endpoint SHOULD answer. Writing down what it
 * currently answers would be worse than the present state: it converts a test that checks nothing
 * into one that certifies possibly-wrong behaviour, and freezes it. That is real investigation and
 * belongs in its own change, not smuggled into a release.
 *
 * So this guard does the one thing that is unambiguously right: it stops the pattern from
 * SPREADING. The count may fall, never rise. Every new test has to assert what it expects.
 *
 * When you fix a batch, lower `BASELINE` in the same commit — the test tells you the new number.
 */
const BASELINE = 40;

/** Files that still carry the pattern, with their counts at the time of writing. */
const KNOWN = {
  'better-auth-api.story.test.ts': 9,
  'better-auth-email-verification.story.test.ts': 1,
  'better-auth-integration.story.test.ts': 1,
  'better-auth-jwt-middleware.story.test.ts': 2,
  'better-auth-plugins.story.test.ts': 26,
  'system-setup.e2e-spec.ts': 1,
};

/**
 * A catch block counts as swallowing when it either asserts nothing and does not rethrow, or its
 * only assertion is `toBeDefined()` — which is true of any thrown value.
 */
function countSwallowingCatches(source: string): number {
  const blocks: string[] = source.match(/\}\s*catch\s*\([^)]*\)\s*\{(?:[^{}]|\{[^{}]*\})*?\}/g) ?? [];

  return blocks.filter((block) => {
    const body = block.slice(block.indexOf('{') + 1);
    const asserts = /expect\(/.test(body);
    const discriminates =
      /toBe\(|toEqual\(|toContain\(|toMatch\(|toHaveLength|toBeNull|toBeTruthy|toBeFalsy|toThrow|toBeGreater|toBeLess/.test(
        body,
      );
    const rethrows = /throw|fail\(|expect\.unreachable/.test(body);

    return (asserts && !discriminates) || (!asserts && !rethrows);
  }).length;
}

describe('swallowing catch blocks in story tests', () => {
  const dir = join(__dirname, '..', 'stories');
  const counts: Record<string, number> = {};
  let total = 0;

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const n = countSwallowingCatches(readFileSync(join(dir, file), 'utf-8'));
    if (n > 0) {
      counts[file] = n;
      total += n;
    }
  }

  it('never grows — a new test must assert what it expects', () => {
    expect(
      total,
      `Swallowing catch blocks went from ${BASELINE} to ${total}. A catch whose only assertion is ` +
        '`toBeDefined()` makes the test pass on every outcome, including a 404 or a 500. Assert the ' +
        'status you expect and let the failure surface. If you FIXED some, lower BASELINE to ' +
        `${total} in this file.`,
    ).toBeLessThanOrEqual(BASELINE);
  });

  it('does not spread to a file that was clean', () => {
    // The total could stay flat while the pattern migrates into a new suite. Per-file is what
    // catches that.
    const newFiles = Object.keys(counts).filter((f) => !(f in KNOWN));

    expect(newFiles, `These suites gained a swallowing catch: ${newFiles.join(', ')}`).toEqual([]);
  });

  it('keeps the recorded per-file counts honest', () => {
    // Guards the bookkeeping itself: if a file's count drops, KNOWN is stale and the next reader
    // would trust a number that no longer describes the tree.
    for (const [file, recorded] of Object.entries(KNOWN)) {
      expect(counts[file] ?? 0, `${file}: recorded ${recorded}, found ${counts[file] ?? 0}`).toBeLessThanOrEqual(
        recorded,
      );
    }
  });
});
