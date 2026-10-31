import { BadRequestException, ConflictException } from '@nestjs/common';

import { ErrorCode } from '../../../modules/error-code/error-codes.js';
import { generateId, generateUuidV7, isUuidV7, isWellFormedId } from '../id-format.js';
import type { SyncDescriptor, SyncIdFormat } from '../model-descriptor.interface.js';
import { SYNC_DELETED_FIELD, SYNC_SYSTEM_FIELDS, SYNC_VERSION_FIELD } from '../sync-model.js';

/**
 * Write rules of synchronized models, shared by every data store (offline-sync plan §3.3) — like the tenant policy,
 * a fix here reaches every database.
 */

/** How often an insert with a SERVER-generated id is tried again when that id is taken (plan §3.3, E6) */
export const SERVER_ID_ATTEMPTS = 3;

/** Fields a tombstone keeps besides the declared scope fields (protocol §2) */
const TOMBSTONE_KEPT = new Set([
  '_id',
  '__v',
  'createdAt',
  'createdBy',
  'id',
  'tenantId',
  'updatedAt',
  'updatedBy',
  ...SYNC_SYSTEM_FIELDS,
]);

/**
 * The record a caller inserts, as a synchronized model stores it: the system fields are the store's (`version: 1`,
 * `deletedAt: null`), whatever the caller sent
 */
export function syncInsertRecord(record: Record<string, any>): Record<string, any> {
  const doc = { ...record };
  for (const field of SYNC_SYSTEM_FIELDS) {
    delete doc[field];
  }
  doc[SYNC_VERSION_FIELD] = 1;
  doc[SYNC_DELETED_FIELD] = null;
  return doc;
}

/** The content fields a delete clears: everything but the id, the system, audit and tenant fields and the scope */
export function tombstoneClearedFields(fields: Iterable<string>, sync: SyncDescriptor): string[] {
  const scope = new Set(sync.scope);
  return [...fields].filter((field) => !TOMBSTONE_KEPT.has(field) && !scope.has(field));
}

/** A new id in the model's format */
export function generateSyncId(format: SyncIdFormat): string {
  return format === 'uuidv7' ? generateUuidV7() : generateId();
}

/** Whether a value is an id in the model's format */
export function isSyncId(value: unknown, format: SyncIdFormat): boolean {
  return format === 'uuidv7' ? isUuidV7(value) : typeof value === 'string' && isWellFormedId(value);
}

/**
 * A client-supplied id, checked against the model's format (protocol §3: `INVALID_ID`). Unlike an ordinary model —
 * which replaces a malformed id with a new one — a synchronized model refuses it: the client keeps its own id and
 * would lose track of the record.
 */
export function assertClientId(value: unknown, format: SyncIdFormat, model: string): string {
  const id = typeof value === 'string' ? value : value?.toString?.();
  if (format === 'objectId' && typeof id === 'string' && isWellFormedId(id)) {
    return id.toLowerCase();
  }
  if (format === 'uuidv7' && isUuidV7(id)) {
    return id;
  }
  throw new BadRequestException(
    `${ErrorCode.INVALID_FIELD_FORMAT} [id]: ${model} takes ${format === 'uuidv7' ? 'a lowercase uuidv7' : 'a 24-character hex ObjectId'} as id`,
  );
}

/** The id an insert names, if any (`id` or `_id`) */
export function suppliedId(record: Record<string, any>): unknown {
  return record.id ?? record._id;
}

/**
 * Insert with a server-generated id, generating a fresh one when it is taken (plan §3.3, E6): server ids are
 * predictable from one observed id, so a client could occupy the next ones; a server id was never shown to anyone, so
 * replacing it is invisible. A client-supplied id is never replaced — its duplicate is the caller's answer.
 */
export async function insertWithServerId<R>(
  format: SyncIdFormat,
  attempt: (id: string) => Promise<R>,
  isIdTaken: (error: unknown) => boolean,
): Promise<R> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt(generateSyncId(format));
    } catch (error) {
      if (tries >= SERVER_ID_ATTEMPTS || !isIdTaken(error)) {
        throw error;
      }
    }
  }
}

/** A conditional change (`expectedVersion`) whose record has another version: the caller resolves and retries */
export class VersionConflictError extends ConflictException {
  override readonly name = 'VersionConflictError';

  constructor(
    readonly model: string,
    readonly id: string,
  ) {
    super(`${ErrorCode.VERSION_CONFLICT}: ${model} ${id} was changed in the meantime`);
  }
}

/** Whether `expectedVersion` is a usable version number */
export function assertExpectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BadRequestException(`${ErrorCode.INVALID_FIELD_FORMAT} [expectedVersion]: a positive integer`);
  }
  return value;
}
