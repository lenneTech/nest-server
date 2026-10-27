import { RequestContext } from '../../services/request-context.service.js';

/**
 * Audit-field decisions (`createdBy` / `updatedBy`), shared by every data store.
 *
 * `mongooseAuditFieldsPlugin` applies them to Mongoose documents and update objects; a SQL store applies
 * the same functions to its rows and patches. Update objects use the Mongo-operator form (`$set`,
 * `$setOnInsert`), which is also the neutral update language of the data store port.
 */

/** Which audit fields a model stores. */
export interface AuditFieldPresence {
  createdBy: boolean;
  updatedBy: boolean;
}

/**
 * The id the audit fields are stamped with: the current user's. `undefined` for system work (no
 * user context: seeding, cron, migrations) — the fields are then left as they are.
 */
export function resolveAuditActorId(): string | undefined {
  return RequestContext.getCurrentUser()?.id || undefined;
}

/**
 * Stamp a document that is being written whole (create, or save of an existing document):
 * `createdBy` only on a NEW document that does not carry one yet, `updatedBy` always.
 */
export function stampAuditOnWrite(
  doc: Record<string, any>,
  actorId: string,
  fields: AuditFieldPresence,
  isNew: boolean,
): void {
  if (fields.createdBy && isNew && !doc['createdBy']) {
    doc['createdBy'] = actorId;
  }
  if (fields.updatedBy) {
    doc['updatedBy'] = actorId;
  }
}

/**
 * Stamp an update object: `updatedBy` flat and inside `$set`, and `createdBy` via `$setOnInsert` for
 * the upsert case — unless the update already sets `createdBy`, which would make the two operators
 * collide on one path.
 */
export function stampAuditOnUpdate(update: Record<string, any>, actorId: string, fields: AuditFieldPresence): void {
  if (fields.updatedBy) {
    update['updatedBy'] = actorId;
    if (update.$set) {
      update.$set['updatedBy'] = actorId;
    }
  }
  if (fields.createdBy && !update['createdBy'] && !update.$set?.['createdBy']) {
    if (!update.$setOnInsert) {
      update.$setOnInsert = {};
    }
    if (!update.$setOnInsert['createdBy']) {
      update.$setOnInsert['createdBy'] = actorId;
    }
  }
}

/**
 * Stamp a replacement document (no operators): `updatedBy`, and `createdBy` when absent — for the
 * upsert case, where the replacement becomes a new document.
 */
export function stampAuditOnReplace(
  replacement: Record<string, any>,
  actorId: string,
  fields: AuditFieldPresence,
): void {
  if (fields.updatedBy) {
    replacement['updatedBy'] = actorId;
  }
  if (fields.createdBy && !replacement['createdBy']) {
    replacement['createdBy'] = actorId;
  }
}
