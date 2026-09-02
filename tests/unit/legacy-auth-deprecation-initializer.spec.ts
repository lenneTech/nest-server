/**
 * `CoreLegacyAuthDeprecationInitializer` — what it says, and when it says nothing.
 *
 * WHY A SPEC FOR A LOGGER
 *
 * Two of its properties are load-bearing and neither is visible to a type-checker:
 *
 * 1. **It must not block the boot.** Nest awaits every `onApplicationBootstrap` hook before
 *    `listen()` resolves, and the status read is collection-scale work. If the hook ever
 *    starts awaiting again, every pod of every rolling deploy pays for a log line, and a
 *    readiness probe can fail while the server counts users. A `void`-ed promise is invisible
 *    to `tsc` — only a test can hold that line.
 *
 * 2. **It reaches the mapper through a DOUBLE optional chain** (`userMapper?.getMigrationStatus?.()`).
 *    A rename on the mapper turns the whole reporting body into a silent no-op: no compile
 *    error, no test failure, and an operator who concludes from the absent line that there is
 *    nothing to report. Pinning the call is the only thing that notices.
 *
 * And one property is a judgement the code makes about which state is dangerous: the warning
 * about an OPEN legacy surface is the obvious one, but the costly mistake is closing it while
 * users still depend on it. Both directions are asserted below.
 *
 * @regression   11.38.0 — the initializer awaited `getMigrationStatus()` on the readiness path,
 *   and reported only the case where legacy auth is still enabled — i.e. it warned in the safe
 *   state and stayed silent in the one where users had just been locked out.
 * @seen-failing Registered mutation `deprecation-initializer-blocks-boot` in
 *   tests/regression-mutations.json — restores the awaited call.
 */

import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CoreLegacyAuthDeprecationInitializer } from '../../src/core/modules/auth/core-legacy-auth-deprecation.initializer';

type LegacyConfig = Record<string, unknown> | undefined;

const configServiceFor = (legacyEndpoints: LegacyConfig): any => ({
  getFastButReadOnly: (key: string) => (key === 'auth' ? { legacyEndpoints } : undefined),
});

/** A mapper whose status call is observable and whose numbers are dictated per test. */
const mapperFor = (status: null | Record<string, unknown>) => {
  const getMigrationStatus = vi.fn().mockResolvedValue(status);
  return { getMigrationStatus, mapper: { getMigrationStatus } as any };
};

/** Runs the hook and lets its detached reporting promise settle. */
const bootAndSettle = async (initializer: CoreLegacyAuthDeprecationInitializer): Promise<void> => {
  initializer.onApplicationBootstrap();
  // The report is deliberately not awaited by the hook, so drain the microtask queue instead
  // of awaiting a handle the production code must not expose.
  await new Promise((resolve) => setImmediate(resolve));
};

describe('CoreLegacyAuthDeprecationInitializer', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  it('does not block the boot on the migration status', () => {
    // The mapper never settles. A hook that awaited it would never return, so the assertion
    // is simply that the call completes — which is exactly the property being protected.
    const neverSettles = { getMigrationStatus: () => new Promise(() => {}) } as any;
    const initializer = new CoreLegacyAuthDeprecationInitializer(configServiceFor({ enabled: true }), neverSettles);

    const result = initializer.onApplicationBootstrap();

    expect(result, 'onApplicationBootstrap must not return a promise the boot would await').toBeUndefined();
  });

  it('warns that legacy auth is open, and names the migration progress', async () => {
    const { mapper, getMigrationStatus } = mapperFor({
      canDisableLegacyAuth: false,
      fullyMigratedUsers: 84,
      migrationPercentage: 87,
      totalUsers: 97,
    });
    const initializer = new CoreLegacyAuthDeprecationInitializer(configServiceFor({ enabled: true }), mapper);

    await bootAndSettle(initializer);

    expect(warn.mock.calls.map(String).join('\n')).toContain('Legacy Auth is ENABLED (GraphQL + REST)');
    expect(log.mock.calls.map(String).join('\n')).toContain('84/97');

    // The addresses are never wanted here — collecting them costs two more collection-scale
    // queries, one a guaranteed COLLSCAN, for a field this reporter discards.
    expect(getMigrationStatus).toHaveBeenCalledWith({ includePendingEmails: false });
  });

  it('names only the transport that is actually open', async () => {
    const { mapper } = mapperFor(null);
    const initializer = new CoreLegacyAuthDeprecationInitializer(configServiceFor({ rest: true }), mapper);

    await bootAndSettle(initializer);

    const message = warn.mock.calls.map(String).join('\n');
    expect(message).toContain('(REST)');
    expect(message).not.toContain('GraphQL');
  });

  it('warns when legacy auth is CLOSED while users still depend on it', async () => {
    // The dangerous state, and the one 11.38.0 made the default. Silence here would be the
    // warning firing in the safe case and staying quiet in the harmful one.
    const { mapper } = mapperFor({
      canDisableLegacyAuth: false,
      fullyMigratedUsers: 12,
      migrationPercentage: 30,
      totalUsers: 40,
    });
    const initializer = new CoreLegacyAuthDeprecationInitializer(configServiceFor(undefined), mapper);

    await bootAndSettle(initializer);

    const message = warn.mock.calls.map(String).join('\n');
    expect(message).toContain('Legacy Auth is DISABLED');
    expect(message).toContain('12/40');
    expect(message, 'the warning must name the way out').toContain('LEGACY_AUTH_ENABLED=true');
  });

  it('stays silent when legacy auth is closed and everyone is migrated', async () => {
    const { mapper } = mapperFor({
      canDisableLegacyAuth: true,
      fullyMigratedUsers: 40,
      migrationPercentage: 100,
      totalUsers: 40,
    });
    const initializer = new CoreLegacyAuthDeprecationInitializer(configServiceFor({ enabled: false }), mapper);

    await bootAndSettle(initializer);

    expect(warn, 'the finished state is the goal — it must not nag').not.toHaveBeenCalled();
  });

  it('survives a mapper that is absent or has lost the method', async () => {
    // The double optional chain exists for the IAM-less legacy deployment. It must degrade to
    // the deprecation warning alone, never to a boot failure.
    const withoutMapper = new CoreLegacyAuthDeprecationInitializer(configServiceFor({ enabled: true }), undefined);
    await bootAndSettle(withoutMapper);
    expect(warn.mock.calls.map(String).join('\n')).toContain('Legacy Auth is ENABLED');

    const withBrokenMapper = new CoreLegacyAuthDeprecationInitializer(configServiceFor({ enabled: true }), {} as any);
    await expect(bootAndSettle(withBrokenMapper)).resolves.toBeUndefined();
  });

  it('does not let a failing status read escape', async () => {
    const failing = { getMigrationStatus: vi.fn().mockRejectedValue(new Error('mongo is down')) } as any;
    const initializer = new CoreLegacyAuthDeprecationInitializer(configServiceFor({ enabled: true }), failing);

    await expect(bootAndSettle(initializer)).resolves.toBeUndefined();
    // The deprecation warning still went out — the status is an addition to it, not a gate on it.
    expect(warn.mock.calls.map(String).join('\n')).toContain('Legacy Auth is ENABLED');
  });
});
