import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { isKillablePid, killTreePlan, killTreeWith } from '../../scripts/check.mjs';

/**
 * The `check` watchdog kills a wedged step's whole process tree: `taskkill /PID <pid> /T /F` on
 * Windows (no `pgrep`, no signals there), the POSIX tree leaves-first elsewhere, and nothing at
 * all for a pid that is not a process we own.
 *
 * Nothing here signals a real process. `killTreeWith()` takes every effect — platform, `run`,
 * `childrenOf`, `signal` — as a required parameter with no default, and these tests pass
 * recorders for all of them. A test that injects the platform but lets the signal path run for
 * real is testing this machine, not the code: a `process.kill(-1, …)` from such a test rebooted
 * a developer's Mac on 2026-09-23 (and again on 2026-09-26). The signal guard
 * (tests/unit/support/signal-guard.ts, a vitest setup file) fails any test that still tries.
 * Ported from lt-monorepo `scripts/kill-tree.test.mjs` (f45cb2c).
 *
 * @regression   11.41.3 — `killTree()` in scripts/check.mjs used `pgrep` + `process.kill`
 *   on every platform, so on Windows the watchdog killed only the shell and orphaned the
 *   vitest tree it was meant to end.
 * @regression   unreleased (after 11.41.4) — a pid that is not ours (`undefined` after a
 *   failed spawn, 0, 1, -1, Windows' 0 and 4) reached `taskkill` or `process.kill`; -1 is the
 *   kill(2) broadcast.
 * @seen-failing Make `killTreePlan()` return the POSIX plan on win32 — registered as mutation
 *   `check-kill-tree-plan-no-win32` in tests/regression-mutations.json; drop the early `return`
 *   after `taskkill` — `check-kill-tree-falls-through-to-pgrep`; open the pid gate —
 *   `check-kill-tree-pid-gate-open`; stop gating the pids `pgrep` returns —
 *   `check-kill-tree-children-ungated`; drop the injection check — `check-kill-tree-effects-optional`;
 *   hard-code the platform killTree() passes — `check-kill-tree-real-platform-dropped`; make its
 *   signal effect a no-op — `check-kill-tree-real-signal-dropped`.
 */

interface KillTreeEffects {
  childrenOf: (pid: number) => number[];
  platform: NodeJS.Platform;
  run: (command: string, args: string[]) => unknown;
  signal: (pid: number, sig: NodeJS.Signals) => unknown;
}

type Calls = { childrenOf: number[]; run: [string, string[]][]; signal: [number, NodeJS.Signals][] };

/** Records every effect instead of performing it. `tree` maps a pid to its direct children. */
function recorder(platform: NodeJS.Platform, tree: Record<number, number[]> = {}): { calls: Calls; deps: KillTreeEffects } {
  const calls: Calls = { childrenOf: [], run: [], signal: [] };
  const deps: KillTreeEffects = {
    childrenOf: (pid) => {
      calls.childrenOf.push(pid);
      return tree[pid] ?? [];
    },
    platform,
    run: (command, args) => calls.run.push([command, args]),
    signal: (pid, sig) => calls.signal.push([pid, sig]),
  };
  return { calls, deps };
}

/** Everything a failed spawn, a corrupt value or a reserved pid can put in `child.pid`. */
const NOT_OURS: unknown[] = [undefined, null, Number.NaN, '4321', 4321.5, -4321, -1, 0, 1];

describe('check.mjs: killTreePlan', () => {
  it('force-kills the whole tree with taskkill on Windows', () => {
    expect(killTreePlan(4321, 'SIGTERM', 'win32')).toEqual({
      args: ['/PID', '4321', '/T', '/F'],
      command: 'taskkill',
    });
  });

  it('keeps /F even for the polite signal, because Windows has no polite stage', () => {
    // `taskkill /T` without `/F` was measured to leave the tree running with the port held.
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      expect(killTreePlan(4321, signal, 'win32')?.args).toContain('/F');
    }
  });

  it('passes the signal through on POSIX and names no command', () => {
    expect(killTreePlan(4321, 'SIGTERM', 'linux')).toEqual({ signal: 'SIGTERM' });
    expect(killTreePlan(4321, 'SIGKILL', 'darwin')).toEqual({ signal: 'SIGKILL' });
  });

  it.each(['win32', 'darwin', 'linux'] as const)('plans nothing for a pid that is not ours (%s)', (platform) => {
    for (const pid of NOT_OURS) expect(killTreePlan(pid, 'SIGTERM', platform), `pid ${String(pid)}`).toBeNull();
  });
});

describe('check.mjs: killTreeWith — pid gate', () => {
  it.each(['win32', 'darwin', 'linux'] as const)('reaches no effect for a pid that is not ours (%s)', (platform) => {
    for (const pid of NOT_OURS) {
      const { calls, deps } = recorder(platform, { 1: [4321] });
      killTreeWith(pid, 'SIGTERM', deps);
      expect(calls, `pid ${String(pid)} on ${platform}`).toEqual({ childrenOf: [], run: [], signal: [] });
    }
  });

  it('refuses the Windows System pids 0 and 4, but not 5', () => {
    for (const pid of [0, 4]) {
      const { calls, deps } = recorder('win32');
      killTreeWith(pid, 'SIGKILL', deps);
      expect(calls.run, `pid ${pid}`).toEqual([]);
    }
    const { calls, deps } = recorder('win32');
    killTreeWith(5, 'SIGKILL', deps);
    expect(calls.run).toEqual([['taskkill', ['/PID', '5', '/T', '/F']]]);
  });

  it('draws the POSIX line between 1 and 2', () => {
    expect(isKillablePid(1, 'linux')).toBe(false);
    expect(isKillablePid(2, 'linux')).toBe(true);
  });
});

describe('check.mjs: killTreeWith — Windows', () => {
  it('runs the plan once and asks neither pgrep nor signals', () => {
    const { calls, deps } = recorder('win32', { 4321: [5000] });
    killTreeWith(4321, 'SIGTERM', deps);
    expect(calls).toEqual({ childrenOf: [], run: [['taskkill', ['/PID', '4321', '/T', '/F']]], signal: [] });
  });

  it('swallows a failing taskkill (tree already gone)', () => {
    const { deps } = recorder('win32');
    deps.run = () => {
      throw new Error('ERROR: The process "4321" not found.');
    };
    expect(() => killTreeWith(4321, 'SIGTERM', deps)).not.toThrow();
  });
});

describe('check.mjs: killTreeWith — POSIX', () => {
  it('signals every pid of the tree, leaves before their parent, each once', () => {
    // 100 ─┬─ 200 ─── 400
    //      └─ 300 ─┬─ 500
    //              └─ 600
    const tree: Record<number, number[]> = { 100: [200, 300], 200: [400], 300: [500, 600] };
    const { calls, deps } = recorder('darwin', tree);
    killTreeWith(100, 'SIGTERM', deps);

    const order = calls.signal.map(([pid]) => pid);
    expect([...order].sort((a, b) => a - b)).toEqual([100, 200, 300, 400, 500, 600]);
    expect(new Set(order).size, 'a pid was signalled twice').toBe(order.length);
    for (const [parent, children] of Object.entries(tree)) {
      for (const child of children) {
        expect(order.indexOf(child), `${child} must die before ${parent}`).toBeLessThan(order.indexOf(Number(parent)));
      }
    }
    expect(calls.signal.every(([, sig]) => sig === 'SIGTERM')).toBe(true);
    expect(calls.run).toEqual([]);
  });

  it('passes SIGKILL through unchanged', () => {
    const { calls, deps } = recorder('linux');
    killTreeWith(4321, 'SIGKILL', deps);
    expect(calls.signal).toEqual([[4321, 'SIGKILL']]);
  });

  it('signals a pid once even when the lookup reports it twice', () => {
    // A pid reused between two pgrep calls can show up under two parents, or loop back.
    const { calls, deps } = recorder('linux', { 100: [200, 200], 200: [100] });
    killTreeWith(100, 'SIGTERM', deps);
    expect(calls.signal).toEqual([
      [200, 'SIGTERM'],
      [100, 'SIGTERM'],
    ]);
  });

  it('drops children that are not ours instead of signalling them', () => {
    const { calls, deps } = recorder('linux', { 100: [1, 0, -1, Number.NaN, 200] });
    killTreeWith(100, 'SIGTERM', deps);
    expect(calls.signal).toEqual([
      [200, 'SIGTERM'],
      [100, 'SIGTERM'],
    ]);
  });

  it('keeps going when the lookup or a signal throws', () => {
    const { calls, deps } = recorder('linux', { 100: [200, 300] });
    const lookup = deps.childrenOf;
    deps.childrenOf = (pid) => {
      if (pid === 200) throw new Error('pgrep: exit 1');
      return lookup(pid);
    };
    const send = deps.signal;
    deps.signal = (pid, sig) => {
      send(pid, sig);
      if (pid === 200) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    };
    killTreeWith(100, 'SIGTERM', deps);
    expect(calls.signal.map(([pid]) => pid)).toEqual([200, 300, 100]);
  });
});

describe('check.mjs: killTreeWith — nothing real by omission', () => {
  it.each(['childrenOf', 'platform', 'run', 'signal'] as const)('throws when `%s` is not injected', (name) => {
    const deps: Partial<KillTreeEffects> = recorder('linux').deps;
    delete deps[name];
    expect(() => killTreeWith(4321, 'SIGTERM', deps as KillTreeEffects)).toThrow(new RegExp(`\`${name}\` must be injected`));
  });
});

describe('check.mjs: killTree call site', () => {
  // Static on purpose: killTree is the one caller that passes the REAL effects, so running it is
  // exactly what the header rules out. Without this, a killTree that bypasses killTreeWith would
  // leave every case above green.
  const source = readFileSync(join(__dirname, '..', '..', 'scripts', 'check.mjs'), 'utf8');
  const body = source.slice(source.indexOf('function killTree('), source.indexOf('\nfunction capture('));

  it('hands the child pid to killTreeWith and signals nothing itself', () => {
    expect(body).toContain('killTreeWith(child.pid, signal, {');
    expect(body.slice(0, body.indexOf('killTreeWith('))).not.toMatch(/process\.kill|execFileSync|pgrep/);
  });

  it('passes the real effects: the running platform, pgrep, taskkill and process.kill', () => {
    // Pinned verbatim. Any one of them swapped passes every recorder test above: `platform:
    // 'linux'` brings back the Windows orphaning, a no-op `signal` leaves the watchdog killing
    // nothing, so a wedged step hangs `check` forever.
    expect(body).toContain('childrenOf: pgrepChildren,');
    expect(body).toContain('platform: process.platform,');
    expect(body).toMatch(/run: \(command, args\) => execFileSync\(command, args, \{ stdio: ['"]ignore['"] \}\),/);
    expect(body).toContain('signal: (pid, sig) => process.kill(pid, sig),');
  });

  it('looks up children with execFileSync, not a shell string', () => {
    expect(source).toContain("execFileSync('pgrep', ['-P', String(pid)]");
    expect(source).not.toMatch(/execSync\(`pgrep/);
  });
});
