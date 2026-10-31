import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SYNC_CLIENT_SCENARIOS } from '../helpers/sync-client-scenarios';

/**
 * Both offline-sync test clients prove the same scenarios (DEV-3819: "a client without a browser passes the same
 * scenarios against the same API"). A scenario one of them leaves out would read, in a report, exactly like one it
 * passed — so the list is declared once and each suite must register every entry, by its id, through `scenario()`.
 */
const SUITES = ['tests/sync-pwa-client.e2e-spec.ts', 'tests/sync-node-client.e2e-spec.ts'];

describe('offline-sync test clients', () => {
  for (const suite of SUITES) {
    it(`${suite} registers every scenario, and only those`, () => {
      const source = readFileSync(join(process.cwd(), suite), 'utf8');
      const registered = [...source.matchAll(/\bscenario\('([a-z-]+)'/g)].map((match) => match[1]).sort();
      expect(registered).toEqual(Object.keys(SYNC_CLIENT_SCENARIOS).sort());
    });
  }
});
