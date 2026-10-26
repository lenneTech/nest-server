/**
 * `CoreBetterAuthUserMapper.getMigrationStatus()` when the application closes its own connection.
 *
 * `CoreLegacyAuthDeprecationInitializer` reads the migration status DETACHED from the boot, so the
 * readiness path never waits for it. A process that closes right after `init()` — `docs:ci`, a
 * script, a test — therefore closes the connection under that read, and the driver rejects it with
 * `MongoClientClosedError`. Nothing failed, but it was logged at ERROR level on every such run.
 *
 * Both halves are asserted: a closed connection is reported at debug level, and every OTHER failure
 * still reaches the error log — a classifier that silenced everything would pass the first half alone.
 *
 * @regression   12.0.0 — `docs:ci` (`scripts/init-server.ts`: init, then close) printed
 *   "ERROR [CoreBetterAuthUserMapper] Error getting migration status: Operation interrupted because
 *   client was closed" twice per run, from the detached boot-time report.
 * @seen-failing Treat no error as a closed connection in getMigrationStatus() in
 *   src/core/modules/better-auth/core-better-auth-user.mapper.ts — registered as mutation
 *   `migration-status-closed-connection-logged-as-error` in tests/regression-mutations.json.
 */
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoreBetterAuthUserMapper } from '../../src/core/modules/better-auth/core-better-auth-user.mapper';

/** A connection whose every read rejects with `error`, the way the driver does after `close()`. */
function connectionFailingWith(error: Error): any {
  const reject = () => Promise.reject(error);
  return {
    collection: () => ({
      aggregate: () => ({ toArray: reject }),
      countDocuments: reject,
      find: () => ({ limit: () => ({ project: () => ({ toArray: reject }) }) }),
    }),
  };
}

function driverError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const EMPTY_STATUS = {
  canDisableLegacyAuth: false,
  fullyMigratedUsers: 0,
  migrationPercentage: 0,
  pendingMigrationUsers: 0,
  pendingUserEmails: [],
  totalUsers: 0,
  usersWithIamAccount: 0,
  usersWithIamId: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getMigrationStatus() and a closed connection', () => {
  it.each([
    ['MongoClientClosedError', 'Operation interrupted because client was closed'],
    ['MongoTopologyClosedError', 'Topology is closed'],
  ])('reports %s at debug level, not as an error', async (name: string, message: string) => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const mapper = new CoreBetterAuthUserMapper(connectionFailingWith(driverError(name, message)));

    await expect(mapper.getMigrationStatus({ includePendingEmails: false })).resolves.toEqual(EMPTY_STATUS);
    expect(error).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('connection was closed'));
  });

  it('still logs every other failure as an error', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const mapper = new CoreBetterAuthUserMapper(
      connectionFailingWith(driverError('MongoServerError', 'not authorized on app to execute command')),
    );

    await expect(mapper.getMigrationStatus({ includePendingEmails: false })).resolves.toEqual(EMPTY_STATUS);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('not authorized on app'));
  });
});
