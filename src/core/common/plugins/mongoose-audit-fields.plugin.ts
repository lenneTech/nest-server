import {
  type AuditFieldPresence,
  resolveAuditActorId,
  stampAuditOnReplace,
  stampAuditOnUpdate,
  stampAuditOnWrite,
} from '../persistence/policies/audit.policy.js';

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
 *
 * The stamping decisions live in the audit policy (`persistence/policies/audit.policy.ts`), which every
 * data store shares; this plugin only applies them to Mongoose's hook shapes.
 */
export function mongooseAuditFieldsPlugin(schema) {
  const fields: AuditFieldPresence = {
    createdBy: !!schema.path('createdBy'),
    updatedBy: !!schema.path('updatedBy'),
  };

  // Skip schemas without audit fields (e.g. BetterAuth sessions, third-party schemas)
  if (!fields.createdBy && !fields.updatedBy) {
    return;
  }

  // Pre-save hook
  schema.pre('save', function () {
    const actorId = resolveAuditActorId();
    if (!actorId) {
      return;
    }
    stampAuditOnWrite(this, actorId, fields, this.isNew);
  });

  // Pre-update hooks (only needed for updatedBy)
  if (fields.updatedBy) {
    const updateHook = function () {
      const actorId = resolveAuditActorId();
      if (!actorId) {
        return;
      }

      const update = this.getUpdate();
      if (!update) {
        return;
      }

      stampAuditOnUpdate(update, actorId, fields);
    };

    schema.pre('findOneAndUpdate', updateHook);
    schema.pre('updateOne', updateHook);
    schema.pre('updateMany', updateHook);

    // Replace hooks: flat replacement doc (no $set/$setOnInsert)
    const replaceHook = function () {
      const actorId = resolveAuditActorId();
      if (!actorId) {
        return;
      }

      const replacement = this.getUpdate();
      if (!replacement) {
        return;
      }

      stampAuditOnReplace(replacement, actorId, fields);
    };

    schema.pre('replaceOne', replaceHook);
    schema.pre('findOneAndReplace', replaceHook);
  }

  // Bulk operation hooks (needed when either createdBy or updatedBy is present)
  // Pre-insertMany hook (Mongoose 9: first arg is docs array)
  schema.pre('insertMany', function (docs) {
    const actorId = resolveAuditActorId();
    if (!actorId) return;
    if (!Array.isArray(docs)) return;

    for (const doc of docs) {
      stampAuditOnWrite(doc, actorId, fields, true);
    }
  });

  // Pre-bulkWrite hook
  schema.pre('bulkWrite', function (ops) {
    const actorId = resolveAuditActorId();
    if (!actorId) return;

    for (const op of ops) {
      if ('insertOne' in op) {
        stampAuditOnWrite(op.insertOne.document, actorId, fields, true);
      } else if ('updateOne' in op || 'updateMany' in op) {
        const update = 'updateOne' in op ? op.updateOne.update : op.updateMany.update;
        if (!update) continue;
        stampAuditOnUpdate(update, actorId, fields);
      } else if ('replaceOne' in op) {
        stampAuditOnReplace(op.replaceOne.replacement, actorId, fields);
      }
    }
  });
}
