/**
 * Public interfaces for the offline sync feature.
 */

export type SyncPushItemAction = 'create' | 'update' | 'delete';

/**
 * One item in a bulk-push request body.
 */
export interface ISyncPushItem {
  /**
   * Optional client-generated UUID for idempotency. When supplied, the
   * server stores the result under (userId, modelName, clientId) for the
   * configured TTL — retries with the same key return the cached result
   * without re-executing the write.
   */
  clientId?: string;

  /** Document ID (omit for create operations). */
  id?: string;

  /** Version the client used as basis for this change. Required for update/delete. */
  version?: number;

  /** Indicates a soft-delete. When true, the item is treated as a delete. */
  deleted?: boolean;

  /** Arbitrary payload — validated against the registered create/update DTO. */
  data?: Record<string, any>;
}

/**
 * Per-item outcome of a bulk-push.
 */
export interface ISyncPushResult {
  /** Echoes back the clientId for client-side correlation. */
  clientId?: string;
  /** ID of the resulting document (or original itemId for not_found / conflict). */
  id?: string;
  /** Resulting status: applied = clean write, merged = field-level LWW resolved,
   *  conflict = strict 409 (serverVersion + serverState provided),
   *  not_found = the document does not exist or is not visible to the user (e.g. cross-tenant),
   *  invalid = DTO validation failed,
   *  error = other server-side failure. */
  status: 'applied' | 'merged' | 'conflict' | 'not_found' | 'invalid' | 'error';
  /** Current server version of the document after the operation (or at conflict). */
  serverVersion?: number;
  /** Current server state — only present on conflict. */
  serverState?: any;
  /** Validation or error details when status is invalid/error. */
  message?: string;
}

/**
 * Response body for GET /sync/:model.
 */
export interface ISyncPullResponse<T = any> {
  changes: T[];
  cursor: string | null;
  hasMore: boolean;
}

/**
 * Response body for POST /sync/:model.
 */
export interface ISyncPushResponse {
  results: ISyncPushResult[];
}

/**
 * Internal registry entry built from `ISyncModelEntry`. Used by the sync
 * service to look up a model's CrudService and DTOs at runtime.
 */
export interface ISyncRegistryEntry {
  name: string;
  service: any;
  createDto?: any;
  updateDto?: any;
  pullLean: boolean;
  tombstoneIndex: boolean;
  maxPushBatch: number;
  maxLimit: number;
  onConflict?: (ctx: any) => Promise<void> | void;
  /** Cached `Map<fieldName, 'lww' | 'strict'>` resolved from `@SyncField` metadata. */
  fieldStrategies: Map<string, 'lww' | 'strict'>;
}
