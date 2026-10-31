import type { SyncOutboxItem, SyncStore } from './sync-client.mjs';

export class SqliteStore implements SyncStore {
  constructor(path: string);
  close(): void;
  run<T>(fn: (tx: any) => Promise<T> | T): Promise<T>;
  /** The unsent changes, for assertions */
  transaction(): { listOutbox(): SyncOutboxItem[] } & Record<string, any>;
}
