import { join } from 'node:path';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthService } from '../src';
import { SYNC_CLIENT_SCENARIOS, type SyncClientScenario } from './helpers/sync-client-scenarios';
import { SYNC_CLIENT_PASSWORD, serverState, signUpSyncUser, syncClientConfig } from './helpers/sync-client-harness';
import { bootSyncTestApp, type SyncTestApp } from './helpers/sync-test-app';

/**
 * The PWA test client in a real browser (DEV-3819 acceptance): `tests/clients/pwa/` — the shared test client
 * (`tests/clients/sync-client.mjs`) on IndexedDB with a service worker — served by the test server itself (same origin),
 * signed in with the Better-Auth session cookie, driven through Playwright's offline emulation. Same scenarios, same API
 * as the Node client in `tests/sync-node-client.e2e-spec.ts` (`tests/helpers/sync-client-scenarios.ts`).
 *
 * The browser is the installed Chrome (`playwright-core` downloads none); GitHub's Ubuntu runners ship it.
 * `SYNC_PWA_CHROME` names another executable. Runs on MongoDB in the `e2e` vitest project and on PostgreSQL in the
 * `postgres` one.
 */
describe('offline sync — PWA in a browser (e2e)', () => {
  let server: SyncTestApp;
  let browser: Browser;
  const contexts: BrowserContext[] = [];

  const scenario = (id: SyncClientScenario, fn: () => Promise<void>) =>
    it(`${id}: ${SYNC_CLIENT_SCENARIOS[id]}`, fn, 90_000);

  /** `window.syncApp.<method>(...args)` in the page */
  const call = <T = any>(page: Page, method: string, ...args: unknown[]): Promise<T> =>
    page.evaluate(([name, values]) => (window as any).syncApp[name](...values), [method, args] as const);

  /** The page's sync runs triggered by `reason` (`start`, `online`, `focus`, `manual`) */
  const runs = (page: Page, reason: string): Promise<any[]> =>
    page.evaluate((wanted) => (window as any).syncApp.events.filter((event: any) => event.reason === wanted), reason);

  const waitForRun = (page: Page, reason: string, count = 1) =>
    page.waitForFunction(
      ([wanted, times]) => (window as any).syncApp.events.filter((event: any) => event.reason === wanted).length >= times,
      [reason, count] as const,
      { timeout: 30_000 },
    );

  /** Open the app and wait until its service worker controls the page — from then on it also loads offline */
  const open = async (context: BrowserContext): Promise<Page> => {
    const page = await context.newPage();
    await page.goto(`${server.baseUrl}/sync-pwa/pwa/`);
    await page.waitForFunction(() => Boolean((window as any).syncApp));
    await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), undefined, { timeout: 30_000 });
    return page;
  };

  /** A device: its own browser profile (cookies, IndexedDB, caches), signed in as `email` */
  const device = async (email: string) => {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await open(context);
    expect(await call(page, 'signIn', email, SYNC_CLIENT_PASSWORD)).toBe(200);
    return { context, page };
  };

  const reload = async (page: Page) => {
    await page.reload();
    await page.waitForFunction(() => Boolean((window as any).syncApp));
  };

  const ids = (notes: any[]) => notes.map((note) => note.id).sort();

  beforeAll(async () => {
    server = await bootSyncTestApp(syncClientConfig(), {
      // Registered before `app.init()`, so the files sit ahead of Nest's not-found handler
      beforeInit: (app) =>
        (app as NestExpressApplication).useStaticAssets(join(process.cwd(), 'tests', 'clients'), { prefix: '/sync-pwa/' }),
    });
    browser = await chromium
      .launch(process.env.SYNC_PWA_CHROME ? { executablePath: process.env.SYNC_PWA_CHROME } : { channel: 'chrome' })
      .catch((error) => {
        throw new Error(
          `No Chrome to run the PWA client in (${(error as Error).message.split('\n')[0]}). Install Google Chrome, or ` +
            'point SYNC_PWA_CHROME at a Chromium executable.',
        );
      });
  });

  afterAll(async () => {
    for (const context of contexts) {
      await context.close().catch(() => undefined);
    }
    await browser?.close();
    await server?.close();
  });

  scenario('offline-crud', async () => {
    const alice = await signUpSyncUser(server.app, 'pwa-crud');
    const { context, page } = await device(alice.email);
    const kept = await call(page, 'create', { title: 'kept' });
    const gone = await call(page, 'create', { title: 'gone' });
    expect((await call(page, 'sync')).applied).toBe(2);

    await context.setOffline(true);
    // The service worker serves the app shell: the page loads without a network
    await reload(page);
    const created = await call(page, 'create', { priority: 1, title: 'made offline' });
    await call(page, 'update', kept.id, { title: 'changed offline' });
    await call(page, 'remove', gone.id);
    expect(await call(page, 'sync')).toMatchObject({ offline: true });
    expect(await call(page, 'outbox')).toHaveLength(3);

    // Back online: the `online` event syncs on its own
    await context.setOffline(false);
    await waitForRun(page, 'online');
    const [online] = await runs(page, 'online');
    expect(online.result).toMatchObject({ applied: 3, conflicts: [], offline: false, rejected: [] });
    expect(await call(page, 'outbox')).toEqual([]);

    const state = await serverState(server.baseUrl, alice.sessionToken);
    expect(state.get(created.id)).toMatchObject({ data: { priority: 1, title: 'made offline' }, deletedAt: null, version: 1 });
    expect(state.get(kept.id)).toMatchObject({ data: { title: 'changed offline' }, version: 2 });
    expect(state.get(gone.id).deletedAt).toBeTruthy();
    expect(ids(await call(page, 'list'))).toEqual([created.id, kept.id].sort());
  });

  scenario('conflict', async () => {
    const alice = await signUpSyncUser(server.app, 'pwa-conflict');
    const phone = await device(alice.email);
    const laptop = await device(alice.email);
    const note = await call(phone.page, 'create', { priority: 1, title: 'shared' });
    await call(phone.page, 'sync');
    await call(laptop.page, 'sync');
    await call(laptop.page, 'update', note.id, { priority: 2 });
    expect((await call(laptop.page, 'sync')).applied).toBe(1);

    await phone.context.setOffline(true);
    await call(phone.page, 'update', note.id, { priority: 3 });
    await phone.context.setOffline(false);
    await waitForRun(phone.page, 'online');
    const [online] = await runs(phone.page, 'online');
    // `priority` is a `reject` field of SyncNote: the stale change conflicts, and the server's version wins
    expect(online.result.conflicts).toHaveLength(1);
    expect(online.result.conflicts[0]).toMatchObject({ id: note.id, status: 'conflict', version: 2 });
    expect(await call(phone.page, 'outbox')).toEqual([]);
    const local = (await call<any[]>(phone.page, 'list')).find((entry) => entry.id === note.id);
    expect(local).toMatchObject({ data: { priority: 2 }, version: 2 });
  });

  scenario('two-tabs', async () => {
    const alice = await signUpSyncUser(server.app, 'pwa-tabs');
    const { context, page: first } = await device(alice.email);
    // A second tab of the same profile: one IndexedDB, one session cookie
    const second = await open(context);
    const note = await call(first, 'create', { title: 'one tab' });
    await call(first, 'sync');

    await context.setOffline(true);
    await call(first, 'update', note.id, { title: 'both tabs push this' });
    const made = await call(second, 'create', { title: 'made in the second tab' });
    expect(await call(first, 'outbox')).toHaveLength(2);

    // Back online, both tabs receive `online` and push the same outbox at the same time
    await context.setOffline(false);
    await Promise.all([waitForRun(first, 'online'), waitForRun(second, 'online')]);
    // A tab whose copy was still in progress in the other one got `retry`; one more round settles it
    await Promise.all([call(first, 'sync'), call(second, 'sync')]);
    for (const tab of [first, second]) {
      for (const event of await tab.evaluate(() => (window as any).syncApp.events)) {
        expect(event.result.conflicts).toEqual([]);
        expect(event.result.rejected).toEqual([]);
      }
    }
    expect(await call(first, 'outbox')).toEqual([]);

    const state = await serverState(server.baseUrl, alice.sessionToken);
    expect(state.get(note.id)).toMatchObject({ data: { title: 'both tabs push this' }, version: 2 });
    expect(state.get(made.id)).toMatchObject({ version: 1 });
    expect(state.size).toBe(2);
  });

  scenario('expired-session', async () => {
    const alice = await signUpSyncUser(server.app, 'pwa-session');
    const { context, page } = await device(alice.email);
    const note = await call(page, 'create', { title: 'before' });
    await call(page, 'sync');

    await context.setOffline(true);
    await call(page, 'update', note.id, { title: 'after signing in again' });
    const made = await call(page, 'create', { title: 'made while signed out' });
    // The browser's session ends while it is offline (expired, or revoked on another device)
    const cookie = (await context.cookies()).find((entry) => entry.name.endsWith('session_token'));
    expect(cookie).toBeDefined();
    const token = decodeURIComponent(cookie!.value).split('.')[0];
    expect(await server.moduleRef.get(CoreBetterAuthService, { strict: false }).revokeSession(token)).toBe(true);

    await context.setOffline(false);
    await waitForRun(page, 'online');
    const [online] = await runs(page, 'online');
    expect(online.result).toMatchObject({ applied: 0, needsLogin: true });
    expect(await call(page, 'outbox')).toHaveLength(2);

    expect(await call(page, 'signIn', alice.email, SYNC_CLIENT_PASSWORD)).toBe(200);
    expect(await call(page, 'sync')).toMatchObject({ applied: 2, conflicts: [], needsLogin: false });
    // Sent again: nothing doubles
    expect(await call(page, 'sync')).toMatchObject({ applied: 0 });

    const state = await serverState(server.baseUrl, alice.sessionToken);
    expect(state.get(note.id)).toMatchObject({ data: { title: 'after signing in again' }, version: 2 });
    expect(state.get(made.id)).toMatchObject({ version: 1 });
    expect(state.size).toBe(2);
  });

  scenario('cleared-storage', async () => {
    const alice = await signUpSyncUser(server.app, 'pwa-cleared');
    const { page } = await device(alice.email);
    for (const title of ['one', 'two', 'three']) {
      await call(page, 'create', { title });
    }
    const removed = await call(page, 'create', { title: 'removed' });
    await call(page, 'sync');
    await call(page, 'remove', removed.id);
    await call(page, 'sync');
    const before = await call<any[]>(page, 'list');
    expect(before).toHaveLength(3);

    // The browser drops the site's storage (Safari does after seven days without interaction): a clean start
    await call(page, 'clearStorage');
    await reload(page);
    await waitForRun(page, 'start');
    const [start] = await runs(page, 'start');
    expect(start.result).toMatchObject({ conflicts: [], offline: false, resynced: false });
    const after = await call<any[]>(page, 'list');
    expect(after.map(({ id, version }) => ({ id, version }))).toEqual(before.map(({ id, version }) => ({ id, version })));
    expect(ids(after)).not.toContain(removed.id);
  });
});
