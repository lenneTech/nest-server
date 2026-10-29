import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The per-request auth path takes ids as strings, whatever the database (DEV-3831): middleware, role guard, token
 * service, cookie and web helpers, and the SQL store they reach. On a SQL source an id is the row's text id, and a
 * check like `Types.ObjectId.isValid(sub)` there would quietly find nobody. The one place on that path that knows what
 * an ObjectId is — the MongoDB user lookup (`core-better-auth-mongo.users.ts`) — is deliberately not in this list.
 *
 * @regression   DEV-3831 (db-agnostic phase 3) — the token service resolved a JWT subject with
 *   `Types.ObjectId.isValid(sub)` + `new Types.ObjectId(sub)` and read the user's id off `_id as Types.ObjectId`.
 * @seen-failing Read the id as `(user._id as Types.ObjectId)` again in BetterAuthTokenService.createUserWithHasRole() in
 *   src/core/modules/better-auth/better-auth-token.service.ts — registered as mutation `iam-request-path-objectid` in
 *   tests/regression-mutations.json.
 */
const REQUEST_PATH = [
  'better-auth-roles.guard.ts',
  'better-auth-token.service.ts',
  'core-better-auth-api.middleware.ts',
  'core-better-auth-cookie.helper.ts',
  'core-better-auth-sql.store.ts',
  'core-better-auth-web.helper.ts',
  'core-better-auth.middleware.ts',
];

/** The code, without comments: a comment may well explain what an ObjectId is */
function code(file: string): string {
  return readFileSync(join(process.cwd(), 'src/core/modules/better-auth', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('per-request auth path: ids are strings', () => {
  it.each(REQUEST_PATH)('%s assumes no ObjectId', (file) => {
    const source = code(file);
    expect(source).not.toMatch(/ObjectId/);
    expect(source).not.toMatch(/from 'mongodb'/);
    // A type import of mongoose's Connection is no assumption about ids; a value import would be
    expect(source).not.toMatch(/^import (?!type )[^;]*from 'mongoose'/m);
  });
});
