/**
 * Enums for Resolver @Role and Model @Restricted decorator and for roles property in ServiceOptions
 */
export enum RoleEnum {
  // ===================================================================================================================
  // Real roles (integrated into user.roles), which can be used via @Restricted for Models (properties),
  // via @Roles for Resolvers (methods) and via ServiceOptions for Resolver methods.
  // ===================================================================================================================

  // User must be an administrator (see roles of user)
  ADMIN = 'admin',

  // ===================================================================================================================
  // Special system roles, which can be used via @Restricted for Models (properties), via @Roles for Resolvers (methods)
  // and via ServiceOptions for Resolver methods. This roles should not be integrated into user.roles!
  // ===================================================================================================================

  // User must be signed in (see context user, e.g. @GraphQLUser)
  S_USER = 's_user',

  // ===================================================================================================================
  // Special system roles that check rights for DB objects and can be used via @Restricted for Models (properties)
  // and via ServiceOptions for Resolver methods. These roles should not be integrated in user.roles!
  // ===================================================================================================================

  // User must be the creator of the processed object(s) (see createdBy property of object(s))
  S_CREATOR = 's_creator',

  // User must be an owner of the processed object(s) (see owners property of object(s))
  S_OWNER = 's_owner',
}
