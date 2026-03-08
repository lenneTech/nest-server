import { RequestContext } from '../services/request-context.service';

/**
 * Mongoose plugin that automatically sets createdBy/updatedBy fields.
 * Uses RequestContext (AsyncLocalStorage) to access the current user.
 *
 * Behavior:
 * - No user context (system operations, seeding): fields are not set
 * - New documents: sets createdBy (if not already set) and updatedBy
 * - Existing documents on save: sets updatedBy
 * - Update operations: sets updatedBy
 *
 * Only activates on schemas that have createdBy and/or updatedBy fields defined.
 */
export function mongooseAuditFieldsPlugin(schema) {
  const hasCreatedBy = !!schema.path('createdBy');
  const hasUpdatedBy = !!schema.path('updatedBy');

  // Skip schemas without audit fields (e.g. BetterAuth sessions, third-party schemas)
  if (!hasCreatedBy && !hasUpdatedBy) {
    return;
  }

  // Pre-save hook
  schema.pre('save', function () {
    const currentUser = RequestContext.getCurrentUser();
    if (!currentUser?.id) {
      return;
    }

    if (hasCreatedBy && this.isNew && !this['createdBy']) {
      this['createdBy'] = currentUser.id;
    }
    if (hasUpdatedBy) {
      this['updatedBy'] = currentUser.id;
    }
  });

  // Pre-update hooks (only needed for updatedBy)
  if (hasUpdatedBy) {
    const updateHook = function () {
      const currentUser = RequestContext.getCurrentUser();
      if (!currentUser?.id) {
        return;
      }

      const update = this.getUpdate();
      if (!update) {
        return;
      }

      // Handle both flat updates and $set operator
      update['updatedBy'] = currentUser.id;
      if (update.$set) {
        update.$set['updatedBy'] = currentUser.id;
      }

      // Handle upsert: set createdBy on insert via $setOnInsert
      // Only add if createdBy is not already in the update (avoids MongoDB path conflict)
      if (hasCreatedBy && !update['createdBy'] && !update.$set?.['createdBy']) {
        if (!update.$setOnInsert) {
          update.$setOnInsert = {};
        }
        if (!update.$setOnInsert['createdBy']) {
          update.$setOnInsert['createdBy'] = currentUser.id;
        }
      }
    };

    schema.pre('findOneAndUpdate', updateHook);
    schema.pre('updateOne', updateHook);
    schema.pre('updateMany', updateHook);
  }
}
