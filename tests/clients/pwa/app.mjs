/**
 * The PWA test client: `SyncClient` on IndexedDB, served by the test server itself (`/sync-pwa/`, same origin), signed
 * in with the Better-Auth session cookie. It syncs at start and on `online` and `focus`, as protocol §2 asks; the
 * suite drives it through `window.syncApp`. Test code, not shipped.
 */
import { IdbStore } from '../idb-store.mjs';
import { SyncClient } from '../sync-client.mjs';

const store = new IdbStore('sync-pwa');
const client = new SyncClient({ model: 'SyncNote', store });
let running;

async function render() {
  const notes = await client.list();
  document.querySelector('#notes').replaceChildren(
    ...notes.map((note) => {
      const item = document.createElement('li');
      item.textContent = `${note.data?.title ?? ''} (v${note.version})`;
      return item;
    }),
  );
}

/** One sync at a time per tab; a second trigger while one runs waits for it and then runs once more */
async function sync(reason) {
  const previous = running;
  running = (async () => {
    await previous?.catch(() => undefined);
    const result = await client.sync();
    window.syncApp.events.push({ reason, result });
    document.querySelector('#status').textContent = result.offline ? 'offline' : result.needsLogin ? 'signed out' : 'synced';
    await render();
    return result;
  })();
  return running;
}

window.syncApp = {
  clearStorage: () => store.destroy(),
  create: (data) => client.create(data),
  events: [],
  list: () => client.list(),
  outbox: () => store.run((tx) => tx.listOutbox()),
  remove: (id) => client.remove(id),
  async signIn(email, password) {
    const response = await fetch('/iam/sign-in/email', {
      body: JSON.stringify({ email, password }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    return response.status;
  },
  sync: () => sync('manual'),
  update: (id, data) => client.update(id, data),
};

window.addEventListener('online', () => void sync('online').catch(() => undefined));
window.addEventListener('focus', () => void sync('focus').catch(() => undefined));

if ('serviceWorker' in navigator) {
  // The shell comes from the cache when the network is gone, so the app also loads offline
  void navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}
void sync('start').catch(() => undefined);
