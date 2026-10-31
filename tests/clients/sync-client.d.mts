// Types of the shared test client, for the TypeScript suites that drive it (the client itself is plain JavaScript,
// because the browser loads the same file)

export interface SyncLocalRecord {
  data?: Record<string, any>;
  deletedAt: null | string;
  id: string;
  updatedAt: null | string;
  version: number;
}

export interface SyncOutboxItem {
  baseVersion?: number;
  data?: Record<string, any>;
  id: string;
  mutationId: string;
  op: 'delete' | 'upsert';
  sentAt?: number;
  seq?: number;
}

export interface SyncRunResult {
  applied: number;
  conflicts: any[];
  needsLogin: boolean;
  offline: boolean;
  rejected: any[];
  resynced: boolean;
  retried: number;
}

export interface SyncStore {
  run<T>(fn: (tx: any) => Promise<T> | T): Promise<T>;
}

export class SyncOfflineError extends Error {}
export class SyncUnauthorizedError extends Error {}
export function newObjectId(): string;
export function newUuidV7(): string;

export class SyncClient {
  constructor(options: {
    baseUrl?: string;
    fetch?: typeof fetch;
    headers?: () => Record<string, string>;
    model: string;
    pageLimit?: number;
    store: SyncStore;
  });
  create(data: Record<string, any>): Promise<SyncLocalRecord>;
  get(id: string): Promise<SyncLocalRecord | undefined>;
  list(): Promise<SyncLocalRecord[]>;
  remove(id: string): Promise<void>;
  sync(): Promise<SyncRunResult>;
  update(id: string, data: Record<string, any>): Promise<SyncLocalRecord>;
}
