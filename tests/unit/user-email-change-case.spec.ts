import { afterEach, describe, expect, it, vi } from 'vitest';

import { CrudService } from '../../src/core/common/services/crud.service';
import { CoreUserService } from '../../src/core/modules/user/core-user.service';

/**
 * An address that differs only in letter case or surrounding whitespace is no address change (12.6.7).
 *
 * `CoreUserService.update()` syncs an address change to IAM (`syncEmailChangeFromLegacy()`), and that sync ends every
 * session of the account, so the user has to sign in again. It compared the stored address with the submitted one as
 * typed, while the address is stored trimmed and in lower case: a profile form sending `Foo@Example.com` back for
 * `foo@example.com` signed the user out everywhere without changing anything.
 *
 * The cases call the REAL `update()` with the persistence call (`CrudService.update`) and the reads replaced.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** The submitted address `update()` passes on to the IAM sync, or `undefined` when it calls no sync */
async function syncedAddressFor(storedEmail: string, submittedEmail: string): Promise<string | undefined> {
  vi.spyOn(CrudService.prototype, 'update').mockResolvedValue({ email: submittedEmail } as any);
  const syncEmailChangeFromLegacy = vi.fn(async () => true);
  const service = Object.create(CoreUserService.prototype) as any;
  Object.defineProperty(service, 'usesNeutralStore', { value: true });
  Object.defineProperty(service, 'dataStore', { value: { findById: async () => ({ email: storedEmail, id: 'u1' }) } });
  service.assertCredentialChangeAllowed = () => undefined;
  service.userServiceLogger = { debug: () => undefined, error: () => undefined, warn: () => undefined };
  service.options = { betterAuthUserMapper: { syncEmailChangeFromLegacy } };

  await service.update('u1', { email: submittedEmail });

  return syncEmailChangeFromLegacy.mock.calls.length ? (syncEmailChangeFromLegacy.mock.calls[0] as any)[1] : undefined;
}

describe('CoreUserService.update(): address change detection', () => {
  /**
   * @regression   12.6.7 — an address that differed only in case counted as a change, and the IAM sync ended every
   *   session of the account.
   * @seen-failing Compare `oldEmail !== input.email` again in CoreUserService.update()
   *   (src/core/modules/user/core-user.service.ts) — registered as mutation `user-email-case-ends-sessions` in
   *   tests/regression-mutations.json.
   */
  it.each([
    ['upper case', 'Foo@Example.com'],
    ['surrounding whitespace', ' foo@example.com '],
  ])('syncs nothing for an address that differs only in %s', async (_case, submitted) => {
    expect(await syncedAddressFor('foo@example.com', submitted)).toBeUndefined();
  });

  it('paired control: syncs a real address change', async () => {
    expect(await syncedAddressFor('foo@example.com', 'bar@example.com')).toBe('bar@example.com');
  });
});
