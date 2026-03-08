import { Logger } from '@nestjs/common';

import { RoleEnum } from '../enums/role.enum';
import { ConfigService } from '../services/config.service';
import { RequestContext } from '../services/request-context.service';

const logger = new Logger('mongooseRoleGuardPlugin');

/**
 * Mongoose plugin that prevents unauthorized users from escalating roles.
 * Uses RequestContext (AsyncLocalStorage) to access the current user.
 *
 * Behavior:
 * - No user context (system operations, seeding): roles changes are allowed
 * - Users with allowed roles: roles changes are allowed
 * - Other users on save: new documents get empty roles, existing documents keep original roles
 * - Other users on update: roles changes are silently removed
 *
 * Configuration via security.mongooseRoleGuardPlugin:
 * - true: Only ADMIN can assign roles (default)
 * - { allowedRoles: ['ADMIN', 'ORGA'] }: ADMIN and ORGA can assign roles
 */
export function mongooseRoleGuardPlugin(schema) {
  // Pre-save hook
  schema.pre('save', function () {
    if (!this.isModified('roles')) {
      return;
    }

    if (isRoleChangeAllowed()) {
      return;
    }

    // Unauthorized: prevent role escalation
    const currentUser = RequestContext.getCurrentUser();
    logger.debug(
      `[nest-server] mongooseRoleGuardPlugin: Blocked role change on ${this.isNew ? 'new' : 'existing'} document by user ${currentUser?.id || 'unknown'}`,
    );
    if (this.isNew) {
      this['roles'] = [];
    } else {
      // Revert to original value
      this.unmarkModified('roles');
    }
  });

  // Pre-findOneAndUpdate hook
  schema.pre('findOneAndUpdate', function () {
    handleUpdateRoleGuard(this.getUpdate());
  });

  // Pre-updateOne hook
  schema.pre('updateOne', function () {
    handleUpdateRoleGuard(this.getUpdate());
  });

  // Pre-updateMany hook
  schema.pre('updateMany', function () {
    handleUpdateRoleGuard(this.getUpdate());
  });
}

/**
 * Check if the current user is allowed to modify roles.
 * Returns true if:
 * - No user context (system operation)
 * - User has ADMIN role
 * - User has one of the configured allowedRoles
 */
function isRoleChangeAllowed(): boolean {
  const currentUser = RequestContext.getCurrentUser();
  // No user context (system operation) → allow
  if (!currentUser) {
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

function handleUpdateRoleGuard(update: any) {
  if (!update) {
    return;
  }

  const hasRolesUpdate = update.roles || update.$set?.roles || update.$push?.roles || update.$addToSet?.roles;
  if (!hasRolesUpdate) {
    return;
  }

  if (isRoleChangeAllowed()) {
    return;
  }

  // Unauthorized: remove roles changes with debug log
  const currentUser = RequestContext.getCurrentUser();
  logger.debug(`Stripped unauthorized roles change from user ${currentUser?.id || 'unknown'}`);
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
}
