/**
 * Every place that writes an auth cookie hands over what it needs to decide `Secure`.
 *
 * Since 11.42.12 `Secure` no longer follows the environment NAME alone: an https deployment sets it
 * whatever it is called. The deciding input reaches the cookie helpers from their CALLERS — the
 * Better-Auth controller and API middleware pass `secureTransport` (Better-Auth's own decision, read
 * off the instance), the legacy controller and resolver pass the server's `baseUrl`. A unit test of a
 * helper cannot see whether a caller passes it, and a caller that stops passing it falls back to the
 * old environment-only rule silently: green everywhere, cookies without `Secure` on every deployed
 * `develop` / `test` stage. So this asserts the call sites themselves.
 *
 * Reads the source — no Nest, no network.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
const CORE = join(ROOT, 'src/core');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** The argument text of every CALL of `fn` (not its declaration), found by balancing parentheses. */
function callArguments(fn: string): { args: string; file: string }[] {
  const calls: { args: string; file: string }[] = [];
  for (const file of sourceFiles(CORE)) {
    // Comments mention these functions too (JSDoc examples, explanations) — only code counts.
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    let from = 0;
    for (;;) {
      const at = source.indexOf(`${fn}(`, from);
      if (at === -1) {
        break;
      }
      from = at + fn.length + 1;
      if (/function\s+$/.test(source.slice(Math.max(0, at - 20), at))) {
        continue;
      }
      let depth = 1;
      let end = from;
      while (end < source.length && depth > 0) {
        if (source[end] === '(') depth++;
        if (source[end] === ')') depth--;
        end++;
      }
      // Forward slashes on every platform: on the Windows CI job `relative()` yields backslashes.
      calls.push({ args: source.slice(from, end - 1), file: relative(ROOT, file).split(sep).join('/') });
    }
  }
  return calls;
}

describe('auth cookie call sites pass the input that decides Secure', () => {
  /**
   * @regression   11.42.12 — the Better-Auth cookie helper decided `Secure` by environment name only;
   *   the fix is worthless at any call site that does not pass `secureTransport`.
   * @seen-failing Remove `secureTransport` from the createCookieHelper() call in
   *   src/core/modules/better-auth/core-better-auth.controller.ts — registered as mutation
   *   `better-auth-controller-drops-secure-transport` in tests/regression-mutations.json.
   */
  it('every createCookieHelper() call passes secureTransport', () => {
    const calls = callArguments('createCookieHelper');
    // The controller and the API middleware. If this number moves, a new call site appeared or one
    // was folded away — either way, look at it before adjusting.
    expect(calls.map((c) => c.file).sort()).toEqual([
      'src/core/modules/better-auth/core-better-auth-api.middleware.ts',
      'src/core/modules/better-auth/core-better-auth.controller.ts',
    ]);
    for (const { args, file } of calls) {
      expect(args, file).toMatch(/\bsecureTransport\s*:/);
    }
  });

  /**
   * @regression   11.42.12 — legacy auth cookies (bearer JWTs) went out without `Secure` on https
   *   deployments that are not production-like.
   * @seen-failing Stop passing `baseUrl` to setLegacyAuthCookies() in
   *   src/core/modules/auth/core-auth.controller.ts — registered as mutation
   *   `legacy-controller-drops-baseurl` in tests/regression-mutations.json.
   */
  it('every setLegacyAuthCookies() call passes the server baseUrl', () => {
    const calls = callArguments('setLegacyAuthCookies');
    expect(calls.map((c) => c.file).sort()).toEqual([
      'src/core/modules/auth/core-auth.controller.ts',
      'src/core/modules/auth/core-auth.resolver.ts',
    ]);
    for (const { args, file } of calls) {
      expect(args.split(',').map((a) => a.trim()), file).toContain('baseUrl');
    }
  });
});
