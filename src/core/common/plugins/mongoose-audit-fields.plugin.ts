import { RequestContext } from '../services/request-context.service';

/**
 * Mongoose plugin that automatically sets createdBy/updatedBy fields.
 * Uses RequestContext (AsyncLocalStorage) to access the current user.
 *
 * Handles save(), findOneAndUpdate(), updateOne(), updateMany(), replaceOne(),
 * findOneAndReplace(), insertMany(), and bulkWrite() operations.
 *
 * Behavior:
 * - No user context (system operations, seeding): fields are not set
 * - New documents: sets createdBy (if not already set) and updatedBy
 * - Existing documents on save: sets updatedBy
 * - Update operations: sets updatedBy
 * - Replace operations: sets updatedBy (and createdBy for upserts)
 * - Bulk operations: sets createdBy/updatedBy per document/operation
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

    // Replace hooks: flat replacement doc (no $set/$setOnInsert)
    const replaceHook = function () {
      const currentUser = RequestContext.getCurrentUser();
      if (!currentUser?.id) {
        return;
      }

      const replacement = this.getUpdate();
      if (!replacement) {
        return;
      }

      replacement['updatedBy'] = currentUser.id;

      // For upsert replacements: set createdBy if not already present
      if (hasCreatedBy && !replacement['createdBy']) {
        replacement['createdBy'] = currentUser.id;
      }
    };

    schema.pre('replaceOne', replaceHook);
    schema.pre('findOneAndReplace', replaceHook);
  }

  // Bulk operation hooks (needed when either createdBy or updatedBy is present)
  // Pre-insertMany hook (Mongoose 9: first arg is docs array)
  schema.pre('insertMany', function (docs) {
    const currentUser = RequestContext.getCurrentUser();
    if (!currentUser?.id) return;
    if (!Array.isArray(docs)) return;

    for (const doc of docs) {
      if (hasCreatedBy && !doc.createdBy) {
        doc.createdBy = currentUser.id;
      }
      if (hasUpdatedBy) {
        doc.updatedBy = currentUser.id;
      }
    }
  });

  // Pre-bulkWrite hook
  schema.pre('bulkWrite', function (ops) {
    const currentUser = RequestContext.getCurrentUser();
    if (!currentUser?.id) return;

    for (const op of ops) {
      if ('insertOne' in op) {
        if (hasCreatedBy && !op.insertOne.document.createdBy) {
          op.insertOne.document.createdBy = currentUser.id;
        }
        if (hasUpdatedBy) {
          op.insertOne.document.updatedBy = currentUser.id;
        }
      } else if ('updateOne' in op || 'updateMany' in op) {
        const update = 'updateOne' in op ? op.updateOne.update : op.updateMany.update;
        if (!update) continue;
        if (hasUpdatedBy) {
          update['updatedBy'] = currentUser.id;
          if (update.$set) {
            update.$set['updatedBy'] = currentUser.id;
          }
        }
        if (hasCreatedBy && !update['createdBy'] && !update.$set?.['createdBy']) {
          if (!update.$setOnInsert) update.$setOnInsert = {};
          if (!update.$setOnInsert['createdBy']) {
            update.$setOnInsert['createdBy'] = currentUser.id;
          }
        }
      } else if ('replaceOne' in op) {
        if (hasUpdatedBy) {
          op.replaceOne.replacement['updatedBy'] = currentUser.id;
        }
        if (hasCreatedBy && !op.replaceOne.replacement['createdBy']) {
          op.replaceOne.replacement['createdBy'] = currentUser.id;
        }
      }
    }
  });
}
