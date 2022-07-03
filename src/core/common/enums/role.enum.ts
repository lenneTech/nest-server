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

  // Everyone, including users who are not logged in, can access (see context user, e.g. @GraphQLUser)
  S_EVERYONE = 's_everyone',

  // No one has access, not even administrators
  S_NO_ONE = 's_no_one',

  // User must be logged in (see context user, e.g. @GraphQLUser)
  S_USER = 's_user',

  // ===================================================================================================================
  // Special system roles that check rights for DB objects and can be used via @Restricted for Models
  // (classes and properties) and via ServiceOptions for Resolver methods. These roles should not be integrated in
  // user.roles!
  // ===================================================================================================================

  // User must be the creator of the processed object(s) (see createdBy property of object(s))
  S_CREATOR = 's_creator',
}
