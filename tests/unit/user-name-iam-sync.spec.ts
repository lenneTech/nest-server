import { afterEach, describe, expect, it, vi } from 'vitest';

import { CrudService } from '../../src/core/common/services/crud.service';
import { CoreUserService } from '../../src/core/modules/user/core-user.service';

/**
 * `CoreUserService.update()` keeps the Better-Auth `name` on the shared users document in step with
 * `firstName` / `lastName`, because the next IAM sign-in reverse-syncs that `name` into both fields.
 *
 * The name it syncs must be the one that was STORED. The value `super.update()` returns went through
 * the output pipeline, and that pipeline strips every field the caller may not read: a caller who may
 * edit `firstName` but not read `lastName` gets a response without `lastName`. Building the name from
 * that response wrote a truncated `name` to the Better-Auth side.
 *
 * Reachable only with a project-specific `@Restricted` on a name field, which the reference server
 * does not carry, so the case is pinned here rather than through the API.
 *
 * @regression   found while integrating PR #647 (DEV-3821) — the first version of the name sync read
 *   `firstName` / `lastName` from the filtered response of `super.update()`.
 * @seen-failing Read the names from `updatedUser` instead of the stored record in
 *   src/core/modules/user/core-user.service.ts — registered as mutation
 *   `user-name-sync-reads-filtered-response` in tests/regression-mutations.json.
 */
describe('CoreUserService.update() name sync to IAM', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const query = (doc: Record<string, unknown>) => {
    const q: Record<string, unknown> = { exec: async () => doc };
    q.lean = () => q;
    q.select = () => q;
    return q;
  };

  const serviceWith = (stored: Record<string, unknown>) => {
    const syncNameChangeFromLegacy = vi.fn(async () => true);
    const service = Object.create(CoreUserService.prototype) as Record<string, unknown>;
    service.mainDbModel = { findById: () => query(stored) };
    service.options = { betterAuthUserMapper: { syncNameChangeFromLegacy } };
    service.assertCredentialChangeAllowed = () => undefined;
    service.userServiceLogger = { debug: () => undefined, error: () => undefined, warn: () => undefined };
    return {
      service: service as unknown as { update(id: string, input: unknown, options?: unknown): Promise<unknown> },
      syncNameChangeFromLegacy,
    };
  };

  it('syncs the stored name, not the one the filtered response carries', async () => {
    const stored = { email: 'anna@test.com', firstName: 'Anna Maria', lastName: 'von Berg' };
    // The caller may not read lastName, so the response lacks it
    vi.spyOn(CrudService.prototype, 'update').mockResolvedValue({ email: stored.email, firstName: 'Anna Maria' });
    const { service, syncNameChangeFromLegacy } = serviceWith(stored);

    await service.update('id-1', { firstName: 'Anna Maria' }, {});

    expect(syncNameChangeFromLegacy).toHaveBeenCalledWith('anna@test.com', 'Anna Maria von Berg');
  });

  it('syncs an emptied name instead of skipping it', async () => {
    const stored = { email: 'anna@test.com', firstName: '', lastName: '' };
    vi.spyOn(CrudService.prototype, 'update').mockResolvedValue({ ...stored });
    const { service, syncNameChangeFromLegacy } = serviceWith(stored);

    await service.update('id-1', { firstName: '', lastName: '' }, {});

    expect(syncNameChangeFromLegacy).toHaveBeenCalledWith('anna@test.com', '');
  });

  it('does not touch the Better-Auth name when neither name field is part of the input', async () => {
    const stored = { email: 'anna@test.com', firstName: 'Anna', lastName: 'Berg' };
    vi.spyOn(CrudService.prototype, 'update').mockResolvedValue({ ...stored });
    const { service, syncNameChangeFromLegacy } = serviceWith(stored);

    await service.update('id-1', { username: 'anna' }, {});

    expect(syncNameChangeFromLegacy).not.toHaveBeenCalled();
  });
});
