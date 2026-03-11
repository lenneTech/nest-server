import { Logger } from '@nestjs/common';

import { RoleEnum } from '../enums/role.enum';
import { ConfigService } from '../services/config.service';
import { RequestContext } from '../services/request-context.service';

const logger = new Logger('mongooseRoleGuardPlugin');

/**
 * Mongoose plugin that prevents unauthorized users from escalating roles.
 * Uses RequestContext (AsyncLocalStorage) to access the current user.
 *
 * Handles save(), findOneAndUpdate(), updateOne(), updateMany(), replaceOne(),
 * findOneAndReplace(), insertMany(), and bulkWrite() operations.
 *
 * **When are role changes allowed?**
 * 1. No user context (system operations, seeding, CLI scripts) → allowed
 * 2. No currentUser on request (e.g. signUp — user not logged in) → allowed
 * 3. User has ADMIN role → allowed
 * 4. User has one of the configured `allowedRoles` → allowed
 * 5. `RequestContext.runWithBypassRoleGuard()` is active → allowed
 * 6. `CrudService.process()` with `force: true` → allowed (auto-bypasses)
 *
 * **When are role changes blocked?**
 * - Logged-in non-admin user without bypass → blocked
 * - On save (new): roles set to `[]`
 * - On save (existing): roles reverted to original
 * - On update/replace: roles stripped from update/replacement object
 * - On insertMany/bulkWrite: roles set to `[]` on inserted documents
 *
 * **Configuration** via `security.mongooseRoleGuardPlugin`:
 * - `true` — Only ADMIN can assign roles (default)
 * - `{ allowedRoles: ['ORGA', 'HR_MANAGER'] }` — Additional roles that can assign roles
 * - `false` — Plugin disabled entirely
 *
 * **Bypass for authorized service code** (e.g. HR system creating users with roles):
 * ```typescript
 * import { RequestContext } from '@lenne.tech/nest-server';
 *
 * // Wrap the database operation in runWithBypassRoleGuard
 * await RequestContext.runWithBypassRoleGuard(async () => {
 *   await this.mainDbModel.create({ email, roles: ['EMPLOYEE'] });
 * });
 *
 * // Or use CrudService.process() with force: true
 * return this.process(
 *   async () => this.mainDbModel.findByIdAndUpdate(id, { roles }),
 *   { serviceOptions, force: true },
 * );
 * ```
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

  // Pre-replaceOne hook (replacement doc is flat, handleUpdateRoleGuard handles update.roles)
  schema.pre('replaceOne', function () {
    handleUpdateRoleGuard(this.getUpdate());
  });

  // Pre-findOneAndReplace hook
  schema.pre('findOneAndReplace', function () {
    handleUpdateRoleGuard(this.getUpdate());
  });

  // Pre-insertMany hook (Mongoose 9: first arg is docs array)
  schema.pre('insertMany', function (docs) {
    if (!Array.isArray(docs)) return;
    if (!docs.some((doc) => doc.roles?.length > 0)) return;
    if (isRoleChangeAllowed()) return;

    const currentUser = RequestContext.getCurrentUser();
    logger.debug(`Stripped unauthorized roles from insertMany by user ${currentUser?.id || 'unknown'}`);
    for (const doc of docs) {
      if (doc.roles) {
        doc.roles = [];
      }
    }
  });

  // Pre-bulkWrite hook
  schema.pre('bulkWrite', function (ops) {
    const hasAnyRoleChange = ops.some((op) => {
      if ('insertOne' in op) return !!op.insertOne.document?.roles?.length;
      if ('updateOne' in op) return hasRolesInUpdate(op.updateOne.update);
      if ('updateMany' in op) return hasRolesInUpdate(op.updateMany.update);
      if ('replaceOne' in op) return !!op.replaceOne.replacement?.roles?.length;
      return false;
    });
    if (!hasAnyRoleChange) return;
    if (isRoleChangeAllowed()) return;

    const currentUser = RequestContext.getCurrentUser();
    logger.debug(`Stripped unauthorized roles from bulkWrite by user ${currentUser?.id || 'unknown'}`);
    for (const op of ops) {
      if ('insertOne' in op) {
        if (op.insertOne.document?.roles) {
          op.insertOne.document.roles = [];
        }
      } else if ('updateOne' in op) {
        handleUpdateRoleGuard(op.updateOne.update);
      } else if ('updateMany' in op) {
        handleUpdateRoleGuard(op.updateMany.update);
      } else if ('replaceOne' in op) {
        if (op.replaceOne.replacement?.roles) {
          delete op.replaceOne.replacement.roles;
        }
      }
    }
  });
}

/**
 * Check if the current user is allowed to modify roles.
 * Returns true if:
 * - No user context (system operation)
 * - bypassRoleGuard is active (via RequestContext.runWithBypassRoleGuard())
 * - User has ADMIN role
 * - User has one of the configured allowedRoles
 */
function isRoleChangeAllowed(): boolean {
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

function hasRolesInUpdate(update: any): boolean {
  return !!(update?.roles || update?.$set?.roles || update?.$push?.roles || update?.$addToSet?.roles);
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
