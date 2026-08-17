import { describe, expect, it } from 'vitest';

import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { warnOnPresignedDownloadsWithRestrictedRoles } from '../../src/core/modules/file/file-roles.helper';

/**
 * A presigned download URL is a BEARER capability: once issued, it works for anyone holding it,
 * from any IP, with no session, until it expires — and it cannot be revoked in between.
 *
 * That is a reasonable trade for public assets. It is almost never what a project means when it
 * also restricts `file.downloadRoles`, because those two settings pull in opposite directions:
 * one says "only these roles may download", the other hands out a link that ignores roles entirely
 * after the first authorized request. The combination reads as deliberate but is usually an
 * oversight, so it is worth one loud line at boot.
 */
describe('presigned downloads vs. restricted download roles', () => {
  it('warns when presigned downloads are combined with the restrictive default roles', () => {
    const message = warnOnPresignedDownloadsWithRestrictedRoles({ presignedDownloads: true } as any, undefined);

    expect(message).toBeDefined();
    expect(message).toMatch(/presigned/i);
    // Must name the consequence, not merely the setting — a warning nobody understands is noise.
    expect(message).toMatch(/revoke|bearer|anyone holding/i);
  });

  it('warns for an explicitly restrictive downloadRoles list', () => {
    const message = warnOnPresignedDownloadsWithRestrictedRoles(
      { presignedDownloads: { expiresInSeconds: 60 } } as any,
      { downloadRoles: ['clinician'] } as any,
    );

    expect(message).toBeDefined();
  });

  it('stays silent when downloads are public (S_EVERYONE) — the case presigning is FOR', () => {
    const message = warnOnPresignedDownloadsWithRestrictedRoles({ presignedDownloads: true } as any, {
      downloadRoles: [RoleEnum.S_EVERYONE],
    } as any);

    expect(message).toBeUndefined();
  });

  it('stays silent when presigned downloads are off', () => {
    expect(
      warnOnPresignedDownloadsWithRestrictedRoles({ presignedDownloads: false } as any, {
        downloadRoles: [RoleEnum.ADMIN],
      } as any),
    ).toBeUndefined();
    expect(
      warnOnPresignedDownloadsWithRestrictedRoles(undefined, { downloadRoles: [RoleEnum.ADMIN] } as any),
    ).toBeUndefined();
    expect(
      warnOnPresignedDownloadsWithRestrictedRoles({ presignedDownloads: { enabled: false } } as any, undefined),
    ).toBeUndefined();
  });

  it('stays silent when S3 is not configured at all', () => {
    expect(warnOnPresignedDownloadsWithRestrictedRoles(undefined, undefined)).toBeUndefined();
  });
});
