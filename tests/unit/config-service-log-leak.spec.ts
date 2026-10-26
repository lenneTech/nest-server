/**
 * A second `new ConfigService(config)` must not print the configuration.
 *
 * `CoreModule.forRoot()` constructs the service from the full server config. Until 12.0.0 the
 * constructor defaulted to `warn: true`, and a construction after the first one merged and then wrote
 * the WHOLE merged config to stdout — every JWT and Better-Auth secret, database and Redis URI and API
 * key in it. That happens whenever `forRoot()` runs a second time in one process: every e2e spec file,
 * scripts that build a testing module, a project with a second application.
 *
 * @regression   12.0.0 — the ConfigService constructor dumped the merged configuration, secrets
 *   included, through `console.warn` on every construction after the first.
 * @seen-failing Default the constructor back to `warn: true` in
 *   src/core/common/services/config.service.ts — registered as mutation
 *   `config-service-dumps-config-by-default` in tests/regression-mutations.json.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';

const SECRET = 'jwt-secret-that-must-never-reach-a-log-line';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConfigService construction output', () => {
  it('prints nothing when constructed again, however much the config contains', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = { env: 'unit', jwt: { refresh: { secret: `${SECRET}-refresh` }, secret: SECRET } };

    new ConfigService(config as any);
    new ConfigService({ ...config, port: 3999 } as any);

    expect(warn.mock.calls.flat().join('\n')).not.toContain(SECRET);
    expect(warn).not.toHaveBeenCalled();
  });

  it('still prints the merged config when a caller asks for it (debugging aid)', () => {
    // The paired case: the fix is a quieter default, not a removed feature.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    new ConfigService({ env: 'unit' } as any);
    new ConfigService({ env: 'unit', port: 3998 } as any, { warn: true });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ConfigService merged'), expect.any(String));
  });
});
