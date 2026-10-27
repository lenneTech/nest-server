import { BadRequestException } from '@nestjs/common';

import { looksLikeSystemRole, SYSTEM_ROLE_PREFIX } from '../../enums/role.enum.js';

/**
 * System-role decisions (which role VALUES may be stored at all), shared by every data store.
 *
 * `mongooseSystemRolePlugin` applies them to Mongoose writes; a SQL store applies the same functions and
 * backs them with a `CHECK` constraint. Unconditional by design: being ADMIN or holding a bypass is
 * authority over a role change, never permission to store a value that is invalid by construction.
 */

/** Normalize an unknown value to a string array; anything else becomes an empty baseline. */
export function toRoleArray(value: unknown): string[] {
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
export function assertNoSystemRoles(roles: unknown, alreadyStored: string[] = []): void {
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

/** Whether an update object carries a system role in any operator form — the cheap pre-check before a baseline read. */
export function updateMayIntroduceSystemRoles(update: any): boolean {
  return collectRoleValues(update).some((role) => looksLikeSystemRole(role));
}

/** Every roles value the update could write, flattened across the operators that can carry one. */
export function collectRoleValues(update: any): unknown[] {
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
export function assertUpdateHasNoSystemRoles(update: any, alreadyStored: string[] = []): void {
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
