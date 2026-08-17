/**
 * Enums for Resolver @Role and Model @Restricted decorator and for roles property in ServiceOptions
 *
 * There are two types of roles. The "normal" roles that can be defined as strings on the user in the `roles` property
 * and there are special system roles (with the prefix `S_`) that are defined by the current context e.g.
 * `S_USER` applies to all logged-in users or `S_CREATOR` applies to the creator of a specific object.
 * The special roles can only be used under certain situations (see below). The "normal" roles can be used anywhere
 * that involves checking the current user.
 *
 * Except for the role `S_NO_ONE` all roles extend the access. If for example the role `ADMIN` is specified for a class
 * then the accesses to all methods / properties are limited to administrators. If then e.g. for a method of the class
 * the role `S_USER` is specified, the method is accessible for all users (administrators & all users = all users). All
 * other methods and properties of the class are still only accessible for administrators.
 *
 * The role `S_NO_ONE` is an exception to this behavior. If this role is specified, then no one can access the
 * associated class or associated methods and properties no matter what other roles were specified for access.
 * This role should be used thus only for classes, methods or characteristics, which are to be locked for a transition
 * period but not deleted from the source code completely.
 *
 * The roles are divided into different scopes and can be used in `@Roles` or `@Restricted`. The scopes are specified
 * and explained below.
 *
 */
export enum RoleEnum {
  // ===================================================================================================================
  // Real roles (integrated into user.roles), which can be used via @Restricted for Models (classes and properties),
  // via @Roles for Resolvers (classes and methods) and via ServiceOptions for Resolver methods.
  // ===================================================================================================================

  // User must be an administrator (see roles of user)
  ADMIN = 'admin',

  // ===================================================================================================================
  // Special system roles, which can be used via @Restricted for Models (classes and properties), via @Roles for
  // Resolvers (classes and methods) and via ServiceOptions for Resolver methods. This roles should not be integrated
  // into user.roles!
  // ===================================================================================================================

  // User must be the creator of the processed object(s) (see createdBy property of object(s))
  S_CREATOR = 's_creator',

  // Everyone, including users who are not logged in, can access (see context user, e.g. @CurrentUser)
  S_EVERYONE = 's_everyone',

  // No one has access, not even administrators (regardless of which roles are still set, access will always be denied)
  S_NO_ONE = 's_no_one',

  // User must be verified (see verified or verifiedAt property of user)
  S_VERIFIED = 's_verified',

  // ===================================================================================================================
  // Special system roles that check rights for DB objects and can be used via @Restricted for Models
  // (classes and properties) and via ServiceOptions for Resolver methods. These roles should not be integrated in
  // user.roles!
  // ===================================================================================================================

  // User must be herself/himself
  S_SELF = 's_self',

  // User must be logged in (see context user, e.g. @CurrentUser)
  S_USER = 's_user',
}

/**
 * Prefix that marks a role as a system role (runtime-context check, never a stored role).
 *
 * This is the single source of truth for the prefix. Anything deriving the system-role rule —
 * guards, the `@Restricted` evaluation, the storage guards — must build on it rather than
 * hard-coding `'s_'` again.
 */
export const SYSTEM_ROLE_PREFIX = 's_';

/**
 * Is this role a system role, by the exact rule the runtime checks use?
 *
 * Case-SENSITIVE on purpose: `hasRole()` and `checkRoleAccess()` compare role strings exactly,
 * so `'S_SELF'` is a different string from `'s_self'` and never grants anything. Widening this
 * to case-insensitive would make the guards treat a legitimately-named project role such as
 * `'S_Manager'` as a system role and change access decisions.
 *
 * Use this for RUNTIME checks. To decide whether a value may be STORED in `user.roles`, use
 * {@link looksLikeSystemRole} — that question deserves the stricter, defensive answer.
 *
 * Declared as a hoisted `function` (not a `const` arrow) so it stays temporal-dead-zone immune
 * on any import cycle — see `.claude/rules/architecture.md` → "DI Token Placement (SWC-Safe)".
 */
export function isSystemRole(role: string): boolean {
  return typeof role === 'string' && role.startsWith(SYSTEM_ROLE_PREFIX);
}

/**
 * Could this value be mistaken for a system role once stored in `user.roles`?
 *
 * Deliberately BROADER than {@link isSystemRole}: trims surrounding whitespace and ignores case.
 * A stored `' s_self'` or `'S_SELF'` grants nothing today, because `hasRole()` compares exactly —
 * but that is an accident of the comparison, not a decision. Both become live the moment anything
 * normalizes roles (a Mongoose `trim: true`, a CSV/LDAP import, a project sanitizer), and both
 * pass an eyeball review as legitimate roles in the meantime.
 *
 * This is the predicate the storage guards use. It is intentionally strict enough to also reject
 * a project role that merely happens to start with `s_` (e.g. `'s_manager'`) — the framework
 * cannot tell those apart from a system role, and a false rejection is recoverable by renaming
 * while a false acceptance is a silent authorization hole.
 */
export function looksLikeSystemRole(role: unknown): boolean {
  return typeof role === 'string' && role.trim().toLowerCase().startsWith(SYSTEM_ROLE_PREFIX);
}

/**
 * Roles that carry GLOBAL, platform-wide authority and can therefore never be satisfied by a
 * tenant membership role.
 *
 * The distinction exists because membership roles are customer-assigned free text: `addMember()`
 * takes any non-empty string, and whoever may manage members is typically a tenant owner — a
 * customer. If a membership role were compared by plain string equality against a framework role,
 * that customer could mint platform-wide authority for themselves simply by naming their tenant
 * role `'admin'`.
 *
 * The two levels are meant to be expressed separately:
 * - **global admin** → `RoleEnum.ADMIN` in `user.roles` — access to every tenant
 * - **tenant admin** → a membership role such as `'tenantAdmin'` / `'spaceAdmin'` — one tenant only
 *
 * Required roles from this set are always resolved against `user.roles`, never against
 * `membership.role`, no matter what the tenant header says.
 */
export const GLOBAL_ONLY_ROLES: readonly string[] = [RoleEnum.ADMIN];

/**
 * Is this a role that only the platform may grant (never a tenant)?
 *
 * Hoisted `function` for the same temporal-dead-zone reason as {@link isSystemRole}.
 */
export function isGlobalOnlyRole(role: string): boolean {
  return typeof role === 'string' && GLOBAL_ONLY_ROLES.includes(role);
}

/**
 * Could this value be mistaken for a global-only role once stored?
 *
 * Stands to {@link isGlobalOnlyRole} exactly as {@link looksLikeSystemRole} stands to
 * {@link isSystemRole}: the runtime rule is exact (so `'ADMIN'` never grants anything), while the
 * storage rule is defensive, because `' Admin '` reads as legitimate in a members list and becomes
 * live the moment anything normalizes role strings.
 */
export function looksLikeGlobalOnlyRole(role: unknown): boolean {
  if (typeof role !== 'string') {
    return false;
  }
  const normalized = role.trim().toLowerCase();
  return GLOBAL_ONLY_ROLES.some((globalRole) => globalRole.toLowerCase() === normalized);
}

/**
 * Is this value unusable as a tenant MEMBERSHIP role?
 *
 * True for system roles (which are runtime-context checks, not stored roles) and for global-only
 * roles (which would cross the tenant boundary). Used to refuse such values at assignment time, so
 * the dangerous membership never comes into existence in the first place.
 *
 * Uses the DEFENSIVE variant of both predicates — see {@link looksLikeSystemRole} and
 * {@link looksLikeGlobalOnlyRole} for why storage deserves the stricter answer than runtime.
 */
export function isForbiddenMembershipRole(role: unknown): boolean {
  return looksLikeSystemRole(role) || looksLikeGlobalOnlyRole(role);
}

/**
 * `class-validator` `@Matches()` pattern that ACCEPTS everything {@link looksLikeSystemRole}
 * rejects, and vice versa.
 *
 * A negative lookahead, so a value is valid exactly when it does NOT begin (after optional leading
 * whitespace, case-insensitively) with the system-role prefix. Kept next to the predicate it
 * mirrors so the two cannot drift; `@Matches` needs a pattern and cannot take a function.
 *
 * Anchored with no quantifier over the input, so it is linear in input length — a 100 KB value
 * costs the same as a 10-character one, with no backtracking to exploit.
 */
export const SYSTEM_ROLE_REJECT_PATTERN = new RegExp(`^(?!\\s*${SYSTEM_ROLE_PREFIX})`, 'i');
