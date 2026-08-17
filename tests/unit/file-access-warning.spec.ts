import { describe, expect, it } from 'vitest';

import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { warnOnUndecidedFileAccess } from '../../src/core/modules/file/file-roles.config';

/**
 * The boot warning for the ONE file configuration nobody chooses on purpose.
 *
 * The role knobs are a coarse audience filter; the per-file rule is the only place "…but only their
 * own" can live. So a deployment that has WIDENED the gate past platform admins and expressed no
 * per-file policy at all has a store that every holder of that role can read in full — and because
 * file ids are enumerable (an ObjectId is timestamp + a per-PROCESS random part + an incrementing
 * counter, so one own upload reveals the neighbourhood) and the file routes are not rate-limited,
 * that is practically reachable rather than theoretically.
 *
 * WHY THE CONDITIONS ARE THIS NARROW. A warning that fires on a correct configuration gets muted, and
 * a muted warning is worse than none — so every way of DECIDING must silence it. There are three, and
 * all three are legitimate:
 *
 *  1. `file.access` names a project class (`'public'`, `'authenticated'`, `'owner'`, `'tenant'`) — the
 *     project said which shape it is;
 *  2. `checkRights()` is overridden — the project wrote its own rule, and grading it is beyond what a
 *     boot check can do;
 *  3. the gate is still admin-only — a platform admin legitimately sees everything.
 *
 * That leaves exactly one case: the gate is open and nothing anywhere says what the policy is. It is
 * the difference between a decision and an omission, which is the only thing a boot warning can
 * usefully detect.
 *
 * Deliberately NOT gated on multi-tenancy any more. Restricting it to tenant projects was the first
 * shape of this warning, and it was too narrow: `downloadRoles: [S_USER]` with no rule leaks every
 * file to every signed-in user whether or not tenants exist. What multi-tenancy changes is only the
 * WORDING — there, the leak also crosses the tenant boundary, and that sentence has to appear.
 *
 * @regression   11.35.0 — the warning fired only when multiTenancy was active, so a single-tenant
 *   project with an open gate and no per-file rule was told nothing.
 * @seen-failing Restore the `!multiTenancyEnabled ||` guard in `warnOnUndecidedFileAccess()` in
 *   `src/core/modules/file/file-roles.config.ts` — registered as mutation
 *   `undecided-file-access-warns-silently` in `tests/regression-mutations.json`.
 */
describe('warnOnUndecidedFileAccess', () => {
  const widened = { downloadRoles: ['editor'] };

  it('warns when the gate is open and nothing decides the policy', () => {
    const message = warnOnUndecidedFileAccess({
      fileConfig: widened,
      hasPerFileRule: false,
      multiTenancyEnabled: false,
    });

    expect(message).toBeTruthy();
    expect(message).toContain('downloadRoles');
    expect(message, 'the operator must be told what to do').toContain('file.access');
    expect(message, 'and why it matters').toMatch(/enumerab|not secret/i);
  });

  it('names the tenant boundary only when there is one to cross', () => {
    const tenant = warnOnUndecidedFileAccess({
      fileConfig: widened,
      hasPerFileRule: false,
      multiTenancyEnabled: true,
    });
    expect(tenant).toMatch(/tenant/i);

    const single = warnOnUndecidedFileAccess({
      fileConfig: widened,
      hasPerFileRule: false,
      multiTenancyEnabled: false,
    });
    expect(single, 'no tenant talk in a single-tenant deployment').not.toMatch(/every tenant/i);
  });

  // ---------------------------------------------------------------------------------------------
  // The three ways of DECIDING, each of which must silence it
  // ---------------------------------------------------------------------------------------------

  it('stays silent when file.access names a project class — including the open ones', () => {
    for (const access of ['authenticated', 'owner', 'public', 'tenant'] as const) {
      expect(
        warnOnUndecidedFileAccess({
          fileConfig: { ...widened, access },
          hasPerFileRule: false,
          multiTenancyEnabled: true,
        }),
        access,
      ).toBeUndefined();
    }
  });

  it('stays silent when checkRights() is overridden', () => {
    expect(
      warnOnUndecidedFileAccess({ fileConfig: widened, hasPerFileRule: true, multiTenancyEnabled: true }),
    ).toBeUndefined();
  });

  it('stays silent on the admin-only default gate', () => {
    expect(
      warnOnUndecidedFileAccess({ fileConfig: undefined, hasPerFileRule: false, multiTenancyEnabled: true }),
    ).toBeUndefined();
    expect(
      warnOnUndecidedFileAccess({
        fileConfig: { deleteRoles: [RoleEnum.ADMIN], downloadRoles: [RoleEnum.ADMIN], uploadRoles: [RoleEnum.ADMIN] },
        hasPerFileRule: false,
        multiTenancyEnabled: false,
      }),
    ).toBeUndefined();
  });

  /** Each knob is its own exposure — a widened DELETE is not less serious than a widened download. */
  it('names every widened knob, not just downloads', () => {
    const message = warnOnUndecidedFileAccess({
      fileConfig: { deleteRoles: ['editor'], uploadRoles: ['contributor'] },
      hasPerFileRule: false,
      multiTenancyEnabled: false,
    });

    expect(message).toContain('deleteRoles');
    expect(message).toContain('uploadRoles');
  });
});
