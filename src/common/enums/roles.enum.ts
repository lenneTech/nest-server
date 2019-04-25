/**
 * Enums for role decorator
 */
export enum RoleEnum {

  // User must be an administrator
  ADMIN = 'admin',

  // User must be the owner of the processed object(s)
  OWNER = 'owner',

  // User must be signed in
  USER = 'user',
}
