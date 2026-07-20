import { describe, expect, it } from 'vitest';

import { enforcePermissionsSecurity } from '../../src/config.env';

/**
 * The permissions report is the full authorization map (routes + roles + @Restricted rules). It must
 * never become a standalone, reachable surface. `enforcePermissionsSecurity()` derives each env's
 * `permissions` from that env's Hub state; this spec locks the invariant, especially the case the rule
 * exists for: "non-local + Hub off + visible permissions" must be impossible.
 */
describe('enforcePermissionsSecurity (permissions follows the Hub)', () => {
  const run = (hub: unknown, permissions: unknown, env = 'development'): unknown => {
    const cfg = { [env]: { hub, permissions } } as never;
    enforcePermissionsSecurity(cfg);
    return (cfg as Record<string, { permissions: unknown }>)[env].permissions;
  };

  it('non-local + Hub OFF → report disabled (never registered / visible)', () => {
    expect(run(undefined, true, 'development')).toBe(false);
    expect(run(false, true, 'ci')).toBe(false);
    expect(run(undefined, { role: false }, 'e2e')).toBe(false);
    expect(run(undefined, undefined, 'production')).toBe(false);
  });

  it('local + Hub OFF → public localhost-only report (role:false) allowed', () => {
    expect(run(undefined, true, 'local')).toEqual({ role: false });
    expect(run(false, undefined, 'local')).toEqual({ role: false });
  });

  it('Hub ON → left as authored (ADMIN stays; the Hub does not force it on)', () => {
    expect(run(true, true, 'development')).toBe(true);
    expect(run({}, true, 'e2e')).toBe(true);
    expect(run({ collectors: {} }, true, 'local')).toBe(true);
  });

  it('Hub ON + permissions OFF stays off (the Hub does NOT need the report — panel just degrades)', () => {
    expect(run(true, false, 'development')).toBe(false);
    expect(run(true, undefined, 'ci')).toBeUndefined();
  });

  it('non-local + Hub ON + PUBLIC report → forced back to ADMIN (never public where reachable)', () => {
    expect(run(true, { role: false }, 'development')).toBe(true);
    expect(run({}, { role: false }, 'staging')).toBe(true);
  });

  it('a disabled Hub object ({ enabled: false }) counts as OFF', () => {
    expect(run({ enabled: false }, true, 'development')).toBe(false);
    expect(run({ enabled: false }, true, 'local')).toEqual({ role: false });
  });
});
