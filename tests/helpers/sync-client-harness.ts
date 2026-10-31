import type { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import envConfig from '../../src/config.env';
import { TestHelper } from '../../src/test/test.helper';

/** Password of every account the client suites create */
export const SYNC_CLIENT_PASSWORD = 'Sync-Client-Password-1!';

/**
 * The server configuration of the client suites: the environment's own (MongoDB in the `e2e` vitest project,
 * PostgreSQL in the `postgres` one, so both clients run on both databases) with offline sync switched on.
 */
export function syncClientConfig(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    ...envConfig,
    auth: { ...envConfig.auth, rateLimit: { enabled: false } },
    ...overrides,
    sync: { cursorSecret: 'sync-client-cursor-secret', hints: { debounceMs: 20 }, rateLimit: false, ...overrides.sync },
  };
}

export interface SyncClientUser {
  email: string;
  /** The opaque Better-Auth session token — a bearer credential the sync routes accept, and what a revoke ends */
  sessionToken: string;
}

const uniqueEmail = (label: string) =>
  `sync-client-${label}-${Date.now()}-${randomBytes(3).toString('hex')}@test.com`.toLowerCase();

/** The session token out of a sign-in's cookies (`<prefix>.session_token=<token>.<signature>`) */
function sessionTokenOf(setCookie: string | string[] | undefined): string {
  for (const cookie of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
    const match = /session_token=([^;]+)/.exec(cookie);
    if (match) {
      return decodeURIComponent(match[1]).split('.')[0];
    }
  }
  throw new Error('the sign-in set no session cookie');
}

/** Sign in through Better-Auth and answer the session token */
export async function signInSyncUser(app: INestApplication, email: string): Promise<string> {
  const response: any = await new TestHelper(app).rest('/iam/sign-in/email', {
    method: 'POST',
    payload: { email, password: SYNC_CLIENT_PASSWORD },
    returnResponse: true,
    statusCode: 200,
  });
  return sessionTokenOf(response.headers['set-cookie']);
}

/** A new account, signed up and signed in through Better-Auth */
export async function signUpSyncUser(app: INestApplication, label: string): Promise<SyncClientUser> {
  const email = uniqueEmail(label);
  await new TestHelper(app).rest('/iam/sign-up/email', {
    method: 'POST',
    payload: { email, name: 'Sync Client', password: SYNC_CLIENT_PASSWORD, termsAndPrivacyAccepted: true },
    statusCode: 201,
  });
  return { email, sessionToken: await signInSyncUser(app, email) };
}

/**
 * What the server holds for the caller, read the way any client reads it — one full pull without a cursor — as the
 * latest item per id, tombstones included. The reference every client's local state is compared with.
 */
export async function serverState(baseUrl: string, token: string, model = 'SyncNote'): Promise<Map<string, any>> {
  const state = new Map<string, any>();
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const query = new URLSearchParams({ limit: '500', ...(cursor ? { cursor } : {}) });
    const response = await fetch(`${baseUrl}/sync/${model}?${query}`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) {
      throw new Error(`pull answered ${response.status}: ${await response.text()}`);
    }
    const body: any = await response.json();
    for (const item of body.items) {
      const known = state.get(item.id);
      if (!known || known.version <= item.version) {
        state.set(item.id, item);
      }
    }
    cursor = body.cursor;
    if (!body.hasMore) {
      return state;
    }
  }
  throw new Error('pull did not end');
}
