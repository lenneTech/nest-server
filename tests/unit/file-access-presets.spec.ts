import { describe, expect, it } from 'vitest';

import { RoleEnum } from '../../src/core/common/enums/role.enum';
import {
  decideFileAccess,
  fileAccessNeedsRawDocument,
  resolveFileAccessPreset,
} from '../../src/core/modules/file/file-access.helper';

/**
 * The four project classes as ONE dial — written as the specification, before the implementation.
 *
 * WHY THIS EXISTS AT ALL: the per-file rule is the only place a sentence like "…but only their own"
 * can live, and until now the framework shipped it as an `@example` to copy. That copy went wrong
 * twice in this repository's own history, both times in the permissive direction:
 *
 *  - `if (!options.currentUser) return true` — reads as "system-internal call", is also exactly what
 *    an anonymous request looks like;
 *  - narrowing only `'id'` / `'filename'` and waving `'filterArgs'` through — which hands over a full
 *    inventory the moment a project surfaces `findFileInfo()`.
 *
 * A preset removes the copying. It must cover every project shape without forcing any of them, so
 * each row below is a class of project rather than a feature:
 *
 * | preset            | project class                                            |
 * |-------------------|----------------------------------------------------------|
 * | `'custom'`        | the project writes its own rule — DEFAULT, framework abstains |
 * | `'public'`        | open: anyone may read and write                          |
 * | `'authenticated'` | login-restricted: every signed-in user may use every file |
 * | `'owner'`         | per-user: only the uploader                              |
 * | `'tenant'`        | per-tenant: only within one's own tenant                 |
 *
 * The decision is a PURE function on purpose: it takes the already-loaded raw document rather than a
 * service, so every row can be stated here without a database — and so the service's only job is to
 * decide whether a lookup is needed at all (`fileAccessNeedsRawDocument`).
 */

const ADMIN = { hasRole: (roles: string[]) => roles.includes(RoleEnum.ADMIN), id: 'admin-1' };
const ALICE = { hasRole: () => false, id: 'alice' };
const BOB = { hasRole: () => false, id: 'bob' };

const owned = (by: string) => ({ metadata: { ownerId: by } });
const inTenant = (tenantId: string) => ({ metadata: { tenantId } });

describe('resolveFileAccessPreset', () => {
  it('defaults to custom, so an existing project is untouched', () => {
    expect(resolveFileAccessPreset(undefined)).toBe('custom');
    expect(resolveFileAccessPreset({})).toBe('custom');
  });

  it('accepts the four declared presets', () => {
    for (const preset of ['authenticated', 'owner', 'public', 'tenant'] as const) {
      expect(resolveFileAccessPreset({ access: preset })).toBe(preset);
    }
  });

  /**
   * An unknown value must NOT silently become permissive. `'custom'` means "the framework abstains",
   * which is right as a default but wrong as the answer to a typo — a project that wrote
   * `access: 'onwer'` believes it has an ownership rule.
   */
  it('falls back to the STRICTEST preset on an unknown value, never to custom', () => {
    expect(resolveFileAccessPreset({ access: 'onwer' as any })).toBe('owner');
  });
});

describe('fileAccessNeedsRawDocument', () => {
  it('needs the document only where the decision reads it', () => {
    expect(fileAccessNeedsRawDocument('owner', 'id')).toBe(true);
    expect(fileAccessNeedsRawDocument('owner', 'filename')).toBe(true);
    expect(fileAccessNeedsRawDocument('tenant', 'id')).toBe(true);
  });

  it('never loads a document for a decision that cannot use one', () => {
    // A write has no document yet, a listing is not about one document, and the two blanket presets
    // answer without looking. Loading anyway would add a query per call for nothing.
    expect(fileAccessNeedsRawDocument('owner', 'file')).toBe(false);
    expect(fileAccessNeedsRawDocument('owner', 'files')).toBe(false);
    expect(fileAccessNeedsRawDocument('owner', 'filterArgs')).toBe(false);
    expect(fileAccessNeedsRawDocument('public', 'id')).toBe(false);
    expect(fileAccessNeedsRawDocument('authenticated', 'id')).toBe(false);
    expect(fileAccessNeedsRawDocument('custom', 'id')).toBe(false);
  });
});

describe('decideFileAccess', () => {
  // -----------------------------------------------------------------------------------------------
  // Cross-cutting: the two things that must hold for EVERY preset
  // -----------------------------------------------------------------------------------------------

  it('lets a forced (system) call through under every preset', () => {
    for (const preset of ['authenticated', 'custom', 'owner', 'public', 'tenant'] as const) {
      expect(decideFileAccess({ checkInputType: 'id', force: true, preset })).toBe(true);
    }
  });

  it('abstains entirely under the default preset, so nothing changes for an existing project', () => {
    for (const type of ['file', 'files', 'filterArgs', 'filename', 'id'] as const) {
      expect(decideFileAccess({ checkInputType: type, preset: 'custom' })).toBe(true);
    }
  });

  // -----------------------------------------------------------------------------------------------
  // Class 1: open
  // -----------------------------------------------------------------------------------------------

  it('public: the role gate is the whole policy, including for an anonymous caller', () => {
    for (const type of ['file', 'filterArgs', 'filename', 'id'] as const) {
      expect(decideFileAccess({ checkInputType: type, preset: 'public' })).toBe(true);
    }
  });

  // -----------------------------------------------------------------------------------------------
  // Class 2: login-restricted
  // -----------------------------------------------------------------------------------------------

  it('authenticated: any signed-in user, nobody else', () => {
    expect(decideFileAccess({ checkInputType: 'id', currentUser: ALICE, preset: 'authenticated' })).toBe(true);
    expect(decideFileAccess({ checkInputType: 'file', currentUser: ALICE, preset: 'authenticated' })).toBe(true);
    expect(decideFileAccess({ checkInputType: 'filterArgs', currentUser: ALICE, preset: 'authenticated' })).toBe(true);
    // A second layer that does not depend on the gate: it holds even if downloadRoles is S_EVERYONE.
    expect(decideFileAccess({ checkInputType: 'id', preset: 'authenticated' })).toBe(false);
  });

  // -----------------------------------------------------------------------------------------------
  // Class 3: per-user
  // -----------------------------------------------------------------------------------------------

  it('owner: the uploader reads their own file, nobody else reads it', () => {
    expect(
      decideFileAccess({ checkInputType: 'id', currentUser: ALICE, preset: 'owner', raw: owned('alice') }),
    ).toBe(true);
    expect(decideFileAccess({ checkInputType: 'id', currentUser: BOB, preset: 'owner', raw: owned('alice') })).toBe(
      false,
    );
    // The by-name branch is covered too: it is a different lookup, and it is the one the presigned
    // path and deleteFileByName() authorize on.
    expect(
      decideFileAccess({ checkInputType: 'filename', currentUser: BOB, preset: 'owner', raw: owned('alice') }),
    ).toBe(false);
  });

  it('owner: ADMIN is not locked out of anything', () => {
    expect(decideFileAccess({ checkInputType: 'id', currentUser: ADMIN, preset: 'owner', raw: owned('alice') })).toBe(
      true,
    );
    expect(decideFileAccess({ checkInputType: 'filterArgs', currentUser: ADMIN, preset: 'owner' })).toBe(true);
  });

  it('owner: FAILS CLOSED without a user, which is what an anonymous request looks like', () => {
    expect(decideFileAccess({ checkInputType: 'id', preset: 'owner', raw: owned('alice') })).toBe(false);
  });

  it('owner: an OWNER-LESS file is not everybody\'s file', () => {
    // Without requiring the field to be present, `String(undefined) === String(undefined)` matches and
    // every unowned file becomes readable by every caller whose id is also missing.
    expect(decideFileAccess({ checkInputType: 'id', currentUser: ALICE, preset: 'owner', raw: {} })).toBe(false);
    expect(decideFileAccess({ checkInputType: 'id', preset: 'owner', raw: {} })).toBe(false);
    expect(decideFileAccess({ checkInputType: 'id', currentUser: ALICE, preset: 'owner', raw: null })).toBe(false);
  });

  it('owner: refuses a LISTING, because a yes/no answer cannot narrow one', () => {
    expect(decideFileAccess({ checkInputType: 'filterArgs', currentUser: ALICE, preset: 'owner' })).toBe(false);
  });

  it('owner: writes fall through to the role gate — an upload has no owner to compare against yet', () => {
    expect(decideFileAccess({ checkInputType: 'file', currentUser: ALICE, preset: 'owner' })).toBe(true);
    expect(decideFileAccess({ checkInputType: 'files', currentUser: ALICE, preset: 'owner' })).toBe(true);
  });

  // -----------------------------------------------------------------------------------------------
  // Class 4: per-tenant (and the base every regulated project builds on)
  // -----------------------------------------------------------------------------------------------

  it('tenant: reads only within the caller\'s own VALIDATED tenant', () => {
    expect(
      decideFileAccess({ checkInputType: 'id', currentUser: ALICE, preset: 'tenant', raw: inTenant('t1'), tenantId: 't1' }),
    ).toBe(true);
    expect(
      decideFileAccess({ checkInputType: 'id', currentUser: ALICE, preset: 'tenant', raw: inTenant('t2'), tenantId: 't1' }),
    ).toBe(false);
  });

  it('tenant: FAILS CLOSED when no tenant is established, and on a tenant-less file', () => {
    // "No tenant in context" is a cron job on the HTTP path and an unresolvable header on the socket
    // path. Neither may read tenant-scoped bytes — a system caller says `force: true` instead.
    expect(
      decideFileAccess({ checkInputType: 'id', currentUser: ALICE, preset: 'tenant', raw: inTenant('t1') }),
    ).toBe(false);
    expect(decideFileAccess({ checkInputType: 'id', currentUser: ALICE, preset: 'tenant', raw: {}, tenantId: 't1' })).toBe(
      false,
    );
  });

  it('tenant: ADMIN crosses tenants, which is what a platform admin is for', () => {
    expect(
      decideFileAccess({ checkInputType: 'id', currentUser: ADMIN, preset: 'tenant', raw: inTenant('t2'), tenantId: 't1' }),
    ).toBe(true);
  });

  it('tenant: refuses a LISTING for the same reason as owner', () => {
    expect(decideFileAccess({ checkInputType: 'filterArgs', currentUser: ALICE, preset: 'tenant', tenantId: 't1' })).toBe(
      false,
    );
  });
});
