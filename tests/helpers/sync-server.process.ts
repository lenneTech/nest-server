/**
 * A reference server with offline sync in a process of its own — the clock-skew suite runs two, because two Nest
 * applications in one process share the persistence registry. Started by `tests/helpers/sync-server-processes.ts`
 * through the framework's SWC loader (as `pnpm start` runs `src/main.ts`), with `tests/helpers/skewed-clock.mjs`
 * preloaded; vitest never imports it. Relative imports name the `.js` file, as ESM requires.
 *
 * `SYNC_SERVER_CONFIG`: overrides of the environment's configuration (JSON, merged deeply). Prints
 * `SYNC_SERVER_READY <port>` once it listens, and closes the application on SIGTERM.
 */
import _ from 'lodash';

import envConfig from '../../src/config.env.js';
import { bootSyncTestApp } from './sync-test-app.js';

const overrides = JSON.parse(process.env.SYNC_SERVER_CONFIG ?? '{}');
const server = await bootSyncTestApp(_.merge({}, envConfig, overrides));
process.stdout.write(`SYNC_SERVER_READY ${server.port}\n`);

const stop = async () => {
  await server.close().catch(() => undefined);
  process.exit(0);
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
