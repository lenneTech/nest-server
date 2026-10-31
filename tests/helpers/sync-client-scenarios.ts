/**
 * The scenarios both offline-sync test clients prove against the same API (DEV-3819 acceptance): the PWA in a browser
 * (`tests/sync-pwa-client.e2e-spec.ts`) and the client without a browser, Node on SQLite
 * (`tests/sync-node-client.e2e-spec.ts`). Both share the protocol code (`tests/clients/sync-client.mjs`) and differ in
 * storage and transport only. `tests/unit/sync-client-scenarios.spec.ts` fails when one of them misses a scenario.
 */
export const SYNC_CLIENT_SCENARIOS = {
  'cleared-storage': 'the device lost its local storage and starts over from a full pull',
  conflict: 'a change made offline meets a newer version on the server; the server wins, nothing else is lost',
  'expired-session': 'the session ends while the device is offline; after signing in again nothing is lost or doubled',
  'offline-crud': 'create, change and delete while offline, then go online: the server has every change once',
  'two-tabs': 'two tabs of one device push the same change at once: one version, no conflict',
} as const;

export type SyncClientScenario = keyof typeof SYNC_CLIENT_SCENARIOS;
