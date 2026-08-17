import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { warnOnUnscopedFilesInTenantMode } from '../../src/core/modules/file/file-roles.helper';
import { describe, expect, it } from 'vitest';

/**
 * The one file-security property no configuration can express — and the warning that says so.
 *
 * The file stores are reached outside Mongoose (GridFS and S3 through their own drivers), so
 * `mongooseTenantPlugin` never scopes them, which is why `CoreFileController` / `CoreFileResolver`
 * carry `@SkipTenantCheck()`. The consequence is easy to miss and impossible to fix with config:
 * `file.downloadRoles: ['editor']` resolves `'editor'` against `user.roles` — a GLOBAL attribute —
 * so every holder of that role reaches EVERY tenant's files. "…but only their own tenant's" needs
 * data, and the only place it can live is `CoreFileService.checkRights()`.
 *
 * A warning cannot make that safe. What it can do is stop the deployment being silent about it, which
 * is the difference between a decision and an accident. The cases below pin WHEN it fires, because a
 * warning that fires on correct configurations gets muted and then never read again.
 */
describe('warnOnUnscopedFilesInTenantMode', () => {
  const widened = { downloadRoles: ['editor'] };

  it('warns when multi-tenancy is on, the gate is widened, and no per-file rule exists', () => {
    const message = warnOnUnscopedFilesInTenantMode({
      fileConfig: widened,
      hasPerFileRule: false,
      multiTenancyEnabled: true,
    });

    expect(message).toBeTruthy();
    expect(message).toContain('checkRights');
    expect(message).toContain('downloadRoles');
    expect(message, 'the operator must be told what to do, not only what is wrong').toContain('tenantId');
  });

  it('stays silent without multi-tenancy — there is no tenant boundary to cross', () => {
    expect(
      warnOnUnscopedFilesInTenantMode({ fileConfig: widened, hasPerFileRule: false, multiTenancyEnabled: false }),
    ).toBeUndefined();
  });

  it('stays silent when a per-file rule exists', () => {
    expect(
      warnOnUnscopedFilesInTenantMode({ fileConfig: widened, hasPerFileRule: true, multiTenancyEnabled: true }),
    ).toBeUndefined();
  });

  /**
   * The default gate is admin-only, and a platform admin legitimately sees every tenant. Warning here
   * would fire for every multi-tenant project that simply left `file` unconfigured.
   */
  it('stays silent on the default admin-only gate', () => {
    expect(
      warnOnUnscopedFilesInTenantMode({ fileConfig: undefined, hasPerFileRule: false, multiTenancyEnabled: true }),
    ).toBeUndefined();
    expect(
      warnOnUnscopedFilesInTenantMode({
        fileConfig: { deleteRoles: [RoleEnum.ADMIN], downloadRoles: [RoleEnum.ADMIN], uploadRoles: [RoleEnum.ADMIN] },
        hasPerFileRule: false,
        multiTenancyEnabled: true,
      }),
    ).toBeUndefined();
  });

  /** Each knob is its own exposure — a widened DELETE is not less serious than a widened download. */
  it('names every widened knob, not just downloads', () => {
    const message = warnOnUnscopedFilesInTenantMode({
      fileConfig: { deleteRoles: ['editor'], uploadRoles: ['contributor'] },
      hasPerFileRule: false,
      multiTenancyEnabled: true,
    });

    expect(message).toContain('deleteRoles');
    expect(message).toContain('uploadRoles');
  });
});
