import { ConflictException } from '@nestjs/common';

/**
 * Payload returned when an optimistic-concurrency check fails on a
 * syncable model.
 *
 * The client is expected to use `serverState` to resolve the conflict
 * locally (manual merge UI, automatic retry, etc.) and then retry the
 * mutation with the up-to-date `serverVersion` as `expectedVersion`.
 */
export interface ISyncConflictPayload {
  /** Mongoose model name (e.g. 'User'). */
  modelName: string;
  /** Document ID that the client tried to update. */
  id: string;
  /** Version number sent by the client (the basis it was operating on). */
  clientVersion: number;
  /** Current version stored on the server. */
  serverVersion: number;
  /** Current document state on the server, as a plain object. */
  serverState: any;
}

/**
 * Thrown by CrudService.update() (and consumed by CoreSyncService) when
 * an `expectedVersion` is provided but does not match the document's
 * current version on the server.
 *
 * Maps to HTTP 409 Conflict. The full payload (including server-side
 * state) is included in the response body so the client can react
 * deterministically without a follow-up round-trip.
 */
export class SyncConflictException extends ConflictException {
  public readonly payload: ISyncConflictPayload;

  constructor(payload: ISyncConflictPayload) {
    super({
      error: 'SyncConflict',
      ...payload,
      message: `Sync conflict on ${payload.modelName} ${payload.id}: client v${payload.clientVersion}, server v${payload.serverVersion}`,
      statusCode: 409,
    });
    this.payload = payload;
  }
}
