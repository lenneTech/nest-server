import { BadRequestException } from '@nestjs/common';

import { looksLikeSystemRole, SYSTEM_ROLE_PREFIX } from '../enums/role.enum';

/**
 * Mongoose plugin that refuses to STORE system roles (`s_*`) in a `roles` array.
 *
 * **This answers a different question than `mongooseRoleGuardPlugin`, which is why it is a
 * separate plugin:**
 *
 * | Plugin | Question | Configurable | On violation |
 * |--------|----------|--------------|--------------|
 * | `mongooseRoleGuardPlugin` | WHO may change roles? | yes (`security.mongooseRoleGuardPlugin`) | strips the change |
 * | `mongooseSystemRolePlugin` | WHICH values may be stored at all? | **no** | throws |
 *
 * Mixing the two would be a mistake in both directions: an ADMIN is allowed to change roles but
 * still must not be able to store `s_self`, and a bypass (`runWithBypassRoleGuard()` / `force:
 * true`) grants authority over the *change*, never permission to write a value that is invalid by
 * construction. So this check runs FIRST and runs ALWAYS — for admins, for bypassed writes, for
 * system operations with no user context.
 *
 * **Why storing one is dangerous:** `hasRole()` is a plain string intersection
 * (`core-user.model.ts`), so a stored `'s_self'` satisfies every `S_SELF` check — including
 * `updateUser` / `deleteUser` on ARBITRARY users (mail/password change → account takeover) —
 * without the account carrying any real role. The rule "NEVER store S_ roles in user.roles" was
 * documented for years; this is where it became enforced.
 *
 * **Why it throws rather than stripping:** silently dropping the value would hide a
 * misconfiguration in an admin tool, which is exactly how the dormant skeleton key gets minted in
 * the first place. A loud 400 is recoverable; a silent success is not observable.
 *
 * **Why the check is broader than the six `RoleEnum.S_*` members:** it rejects ANY value that
 * looks like a system role after trimming and lower-casing (see {@link looksLikeSystemRole}).
 * The framework cannot distinguish a future system role from a project role that happens to start
 * with `s_`, and a false rejection is fixable by renaming while a false acceptance is a silent
 * authorization hole. Projects using an `s_`-prefixed role name must rename it — see the
 * 11.34.x-to-11.35.x migration guide.
 *
 * Registered unconditionally in `CoreModule` — unlike the configurable plugins beside it, there is
 * no opt-out, because there is no legitimate reason to store one of these values.
 */
export function mongooseSystemRolePlugin(schema) {
  schema.pre('save', function () {
    if (!this.isModified('roles')) {
      return;
    }
    // A NEW document has no stored baseline, so every value in it is being introduced.
    assertNoSystemRoles(this['roles'], this.isNew ? [] : toRoleArray(this.$__.originalRoles));
  });

  // Capture the pre-modification value so the save hook above can tell an introduced value from a
  // pre-existing one. `init` fires when a document is hydrated from the database.
  schema.post('init', function () {
    this.$__.originalRoles = Array.isArray(this['roles']) ? [...this['roles']] : undefined;
  });

  for (const op of ['findOneAndUpdate', 'updateOne', 'replaceOne', 'findOneAndReplace']) {
    schema.pre(op, async function () {
      await assertUpdateIntroducesNoSystemRoles(this);
    });
  }

  // updateMany can span documents with different stored values, so there is no single baseline to
  // compare against. Any system role in the update payload is refused outright.
  schema.pre('updateMany', function () {
    assertUpdateHasNoSystemRoles(this.getUpdate());
  });

  schema.pre('insertMany', function (docs) {
    if (!Array.isArray(docs)) {
      return;
    }
    for (const doc of docs) {
      assertNoSystemRoles(doc?.roles);
    }
  });

  schema.pre('bulkWrite', function (ops) {
    if (!Array.isArray(ops)) {
      return;
    }
    for (const op of ops) {
      if ('insertOne' in op) {
        assertNoSystemRoles(op.insertOne.document?.roles);
      } else if ('updateOne' in op) {
        assertUpdateHasNoSystemRoles(op.updateOne.update);
      } else if ('updateMany' in op) {
        assertUpdateHasNoSystemRoles(op.updateMany.update);
      } else if ('replaceOne' in op) {
        assertNoSystemRoles(op.replaceOne.replacement?.roles);
      }
    }
  });
}

/** Normalize an unknown value to a string array; anything else becomes an empty baseline. */
function toRoleArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Throw if the write INTRODUCES a system role.
 *
 * `alreadyStored` is the document's current value. A system role that is already in there is NOT
 * refused, and this is load-bearing rather than lenient: `CrudService.update()` writes the whole
 * object back, so a login (`updateRefreshToken` → `update`) re-sends the stored `roles` verbatim.
 * Refusing that would lock every already-contaminated account out of the system on upgrade — and
 * would do the same, fleet-wide, to any project whose own role name happens to start with `s_`.
 * An upgrade must not cause a login outage; cleaning up stored values is what the migration guide's
 * audit query is for.
 *
 * Accepts anything: a non-array (nothing to check) and non-string elements (cannot be a system
 * role) pass through untouched — type validation is not this plugin's job.
 */
function assertNoSystemRoles(roles: unknown, alreadyStored: string[] = []): void {
  if (!Array.isArray(roles)) {
    return;
  }

  const introduced = roles.filter((role) => looksLikeSystemRole(role) && !alreadyStored.includes(role));
  if (introduced.length) {
    throw new BadRequestException(
      `System roles (${SYSTEM_ROLE_PREFIX}*) must never be stored in user.roles: ${introduced.join(', ')}`,
    );
  }
}

/**
 * Query-level variant: resolves the affected document's stored roles before deciding.
 *
 * The lookup is skipped entirely unless the payload actually carries a system role, so the common
 * case costs nothing — only a write that is about to be refused pays for one extra read.
 */
async function assertUpdateIntroducesNoSystemRoles(query: any): Promise<void> {
  const update = query.getUpdate();
  if (!update || !collectRoleValues(update).some((role) => looksLikeSystemRole(role))) {
    return;
  }

  // Only now — the payload is suspicious, so the baseline is worth one read.
  let stored: string[] = [];
  try {
    const current = await query.model.findOne(query.getFilter()).select('roles').lean().exec();
    stored = toRoleArray(current?.roles);
  } catch {
    // A failed lookup must not turn into an allow: fall through with an empty baseline, which
    // refuses the write. Failing closed is correct for an authorization invariant.
  }

  assertUpdateHasNoSystemRoles(update, stored);
}

/** Every roles value the update could write, flattened across the operators that can carry one. */
function collectRoleValues(update: any): unknown[] {
  const values: unknown[] = [
    ...toRoleArray(update.roles),
    ...toRoleArray(update.$set?.roles),
    ...toRoleArray(update.$setOnInsert?.roles),
  ];

  for (const operator of [update.$push?.roles, update.$addToSet?.roles]) {
    if (operator === undefined || operator === null) {
      continue;
    }
    values.push(...(Array.isArray(operator?.$each) ? operator.$each : [operator]));
  }

  return values;
}

/**
 * Check every operator through which a roles value can reach the document.
 *
 * `$pull` is deliberately NOT checked — removing an `s_*` value from a document that already has
 * one is exactly the cleanup this release asks projects to perform, so it must stay possible.
 */
function assertUpdateHasNoSystemRoles(update: any, alreadyStored: string[] = []): void {
  if (!update) {
    return;
  }

  assertNoSystemRoles(update.roles, alreadyStored);
  assertNoSystemRoles(update.$set?.roles, alreadyStored);
  assertNoSystemRoles(update.$setOnInsert?.roles, alreadyStored);

  // $push / $addToSet take either a bare value or a { $each: [...] } modifier
  for (const operator of [update.$push?.roles, update.$addToSet?.roles]) {
    if (operator === undefined || operator === null) {
      continue;
    }
    assertNoSystemRoles(Array.isArray(operator?.$each) ? operator.$each : [operator], alreadyStored);
  }
}
