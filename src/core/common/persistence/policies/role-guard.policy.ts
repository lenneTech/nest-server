import { RoleEnum } from '../../enums/role.enum.js';
import { ConfigService } from '../../services/config.service.js';
import { RequestContext } from '../../services/request-context.service.js';

/**
 * Role-assignment decisions (who may change `roles`), shared by every data store.
 *
 * `mongooseRoleGuardPlugin` applies them to Mongoose documents and update objects; a SQL store applies
 * the same functions to its writes. This answers WHO may change roles (configurable, bypassable, strips
 * the change); which VALUES may exist at all is the system-role policy's question.
 */

/**
 * Check if the current user is allowed to modify roles.
 * Returns true if:
 * - No user context (system operation)
 * - bypassRoleGuard is active (via RequestContext.runWithBypassRoleGuard())
 * - User has ADMIN role
 * - User has one of the configured allowedRoles
 */
export function isRoleChangeAllowed(): boolean {
  const currentUser = RequestContext.getCurrentUser();
  // No user context (system operation) → allow
  if (!currentUser) {
    return true;
  }
  // Explicit bypass (e.g. signUp with default roles, authorized service operations)
  if (RequestContext.isBypassRoleGuard()) {
    return true;
  }
  // Admin → always allow
  if (currentUser.hasRole?.([RoleEnum.ADMIN]) || currentUser.roles?.includes(RoleEnum.ADMIN)) {
    return true;
  }

  // Check configured allowedRoles
  const pluginConfig = ConfigService.configFastButReadOnly?.security?.mongooseRoleGuardPlugin;
  if (pluginConfig && typeof pluginConfig === 'object' && 'allowedRoles' in pluginConfig && pluginConfig.allowedRoles) {
    const allowedRoles: string[] = pluginConfig.allowedRoles as string[];
    if (currentUser.roles?.some((role: string) => allowedRoles.includes(role))) {
      return true;
    }
  }

  return false;
}

/** Whether an update object (flat or with operators) touches `roles`. */
export function updateChangesRoles(update: any): boolean {
  return !!(
    update?.roles ||
    update?.$set?.roles ||
    update?.$push?.roles ||
    update?.$addToSet?.roles ||
    update?.$pull?.roles
  );
}

/** Remove every change to `roles` from an update object, in all operator forms. */
export function stripRoleChanges(update: any): void {
  delete update.roles;
  if (update.$set?.roles) {
    delete update.$set.roles;
  }
  if (update.$push?.roles) {
    delete update.$push.roles;
  }
  if (update.$addToSet?.roles) {
    delete update.$addToSet.roles;
  }
  if (update.$pull?.roles) {
    delete update.$pull.roles;
  }
}
