import { describe, expect, it } from 'vitest';

import { createBetterAuthInstance } from '../../src/core/modules/better-auth/better-auth.config';

/**
 * `betterAuth.options.user` is merged into the framework's `user` block, not swapped for it (11.44.2).
 *
 * The framework gives Better-Auth `user: { modelName: 'users', additionalFields }`: the collection or table it shares
 * with the user model, and the fields `additionalUserFields` declares, among them the `input: false` locks on `roles`,
 * `verified` and `twoFactorEnabled`. `options` used to be spread over that configuration, so a project that set
 * `options.user` for its own reason (`changeEmail`, `deleteUser`) replaced the whole block: Better-Auth then read and wrote
 * a `user` collection the framework never sees, and knew none of the additional fields.
 *
 * The cases build the REAL `createBetterAuthInstance()` and read the options Better-Auth itself was given.
 */

/** Minimal MongoDB `Db` stand-in: every lookup finds nothing. */
const fakeDb: any = {
  collection: () => ({
    aggregate: () => ({ toArray: async () => [] }),
    createIndex: async () => undefined,
    find: () => {
      const cursor: any = { limit: () => cursor, skip: () => cursor, sort: () => cursor, toArray: async () => [] };
      return cursor;
    },
    findOne: async () => null,
    insertOne: async () => ({ insertedId: 'x' }),
  }),
};

const VALID_SECRET = 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing';

/** The `user` options Better-Auth received for the given `betterAuth.options.user` */
async function userOptionsFor(user: Record<string, unknown>): Promise<any> {
  const result = createBetterAuthInstance({
    config: { enabled: true, options: { user }, secret: VALID_SECRET } as any,
    db: fakeDb,
  } as any);
  expect(result).not.toBeNull();
  return (await result!.instance.$context).options.user;
}

describe('betterAuth.options.user merge', () => {
  /**
   * @regression   11.44.2 — a project's `options.user` replaced the framework's `user` block: `modelName: 'users'` and
   *   every additional field (with the `input: false` locks) were gone.
   * @seen-failing Remove the `user` merge from createBetterAuthInstance()
   *   (src/core/modules/better-auth/better-auth.config.ts) — registered as mutation `iam-options-user-replaces-block`
   *   in tests/regression-mutations.json.
   */
  it('keeps the shared model and the framework fields when a project sets its own user options', async () => {
    const user = await userOptionsFor({ changeEmail: { enabled: true } });

    expect(user.changeEmail).toEqual({ enabled: true });
    expect(user.modelName).toBe('users');
    expect(user.additionalFields?.roles?.input).toBe(false);
    expect(user.additionalFields?.verified?.input).toBe(false);
  });

  /**
   * @regression   11.44.2 — the same merge must not let a project field of the same name reopen a lock.
   * @seen-failing Spread the framework's additional fields BEFORE the project's in the `user` merge — registered as
   *   mutation `iam-options-user-fields-override-locks` in tests/regression-mutations.json.
   */
  it("keeps the framework's lock when a project declares the same field", async () => {
    const user = await userOptionsFor({ additionalFields: { roles: { input: true, type: 'string[]' } } });

    expect(user.additionalFields.roles.input).toBe(false);
  });

  /**
   * @regression   11.44.2 — a project field under another key that maps to a protected column
   *   (`customRoles: { fieldName: 'roles', input: true }`) fed client input into `roles` through the merged block.
   * @seen-failing Drop the `lockProtectedColumns()` call after the `user` merge in createBetterAuthInstance()
   *   (src/core/modules/better-auth/better-auth.config.ts) — registered as mutation
   *   `iam-options-user-shadow-field-unlocked` in tests/regression-mutations.json.
   */
  it('locks a project field that maps to a protected column under another key, without touching its config', async () => {
    const shadow = Object.freeze({ fieldName: 'roles', input: true, type: 'string[]' });
    const user = await userOptionsFor({ additionalFields: Object.freeze({ customRoles: shadow }) });

    expect(user.additionalFields.customRoles.input).toBe(false);
    expect(shadow.input).toBe(true);
  });

  it('paired control: adds a field the framework does not declare', async () => {
    const user = await userOptionsFor({ additionalFields: { nickname: { required: false, type: 'string' } } });

    expect(user.additionalFields.nickname).toMatchObject({ type: 'string' });
    expect(user.additionalFields.roles.input).toBe(false);
  });

  it('paired control: an explicit modelName still wins', async () => {
    expect((await userOptionsFor({ modelName: 'accounts_users' })).modelName).toBe('accounts_users');
  });
});
