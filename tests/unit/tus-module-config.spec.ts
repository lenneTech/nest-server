/**
 * Unit Tests: what `TusModule.forRoot()` makes of the configuration.
 *
 * Two contracts, both broken before 11.42.9:
 *
 * 1. The server configuration's `tus` key applies when `forRoot()` gets no explicit `config` — the
 *    zero-config rule BetterAuthModule.forRoot() follows. It was never read, so `tus: false`,
 *    `allowedTypes` and `maxSize` in config.env.ts did nothing.
 * 2. The controller's route and `tus.path` agree. The core controller always listened at `/tus` while a
 *    configured `path` only changed the upload URLs handed to clients, so every resume after a
 *    non-default `path` answered 404.
 */
import { Controller } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IServerOptions, ITusConfig } from '../../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreTusController } from '../../src/core/modules/tus/core-tus.controller';
import { CoreTusService } from '../../src/core/modules/tus/core-tus.service';
import { TUS_CONFIG } from '../../src/core/modules/tus/tus.constants';
import { TusModule } from '../../src/core/modules/tus/tus.module';

@Controller('files/upload')
class ProjectTusController extends CoreTusController {}

const tusConfigOf = (module: ReturnType<typeof TusModule.forRoot>) =>
  (module.providers ?? []).find((provider: any) => provider?.provide === TUS_CONFIG) as { useValue: ITusConfig | null };

describe('TusModule.forRoot() configuration', () => {
  let previousConfig: Partial<IServerOptions>;

  beforeEach(() => {
    previousConfig = ConfigService.config ?? {};
  });

  afterEach(() => {
    TusModule.reset();
    TusModule.forRoot(); // restores the controller route an earlier case moved
    TusModule.reset();
    ConfigService.setConfig(previousConfig as IServerOptions, { reInit: true });
  });

  const serverConfig = (tus: IServerOptions['tus']) =>
    ConfigService.setConfig({ ...(previousConfig as IServerOptions), tus }, { reInit: true });

  /**
   * @regression   11.42.9 — the server configuration's `tus` key was never read: `forRoot()` without
   *   an explicit `config` always enabled TUS with defaults, so `tus: false`, `allowedTypes` and
   *   `maxSize` in config.env.ts silently did nothing.
   * @seen-failing Read only the explicit `config` in TusModule.forRoot()
   *   (src/core/modules/tus/tus.module.ts) — registered as mutation `tus-server-config-ignored` in
   *   tests/regression-mutations.json.
   */
  it('applies the server configuration when forRoot() gets no config', () => {
    serverConfig(false);
    expect(TusModule.forRoot().controllers ?? []).toHaveLength(0);

    serverConfig({ allowedTypes: ['image/png'], maxSize: 1024 });
    const config = tusConfigOf(TusModule.forRoot()).useValue;
    expect(config?.allowedTypes).toEqual(['image/png']);
    expect(config?.maxSize).toBe(1024);
  });

  it('lets an explicit config win over the server configuration', () => {
    serverConfig(false);
    const module = TusModule.forRoot({ config: { maxSize: 2048 } });
    expect(module.controllers).toEqual([CoreTusController]);
    expect(tusConfigOf(module).useValue?.maxSize).toBe(2048);
  });

  /**
   * @regression   11.42.9 — a configured `tus.path` changed only the upload URL handed to the client;
   *   the controller kept listening at `/tus`, so every HEAD / PATCH on that URL answered 404.
   * @seen-failing Drop the applyPath() call from TusModule.forRoot() (src/core/modules/tus/tus.module.ts)
   *   — registered as mutation `tus-path-not-applied` in tests/regression-mutations.json.
   */
  it('mounts the controller at a configured path, and restores its own route afterwards', () => {
    const moved = TusModule.forRoot({ config: { path: '/uploads/' } });
    expect(Reflect.getMetadata(PATH_METADATA, CoreTusController)).toBe('uploads');
    expect(tusConfigOf(moved).useValue?.path).toBe('/uploads');

    const restored = TusModule.forRoot({ config: {} });
    expect(Reflect.getMetadata(PATH_METADATA, CoreTusController)).toBe('tus');
    expect(tusConfigOf(restored).useValue?.path).toBe('/tus');
  });

  /**
   * @regression   11.42.9 (pre-release review) — a `path` naming the PUBLIC URL (global prefix or a
   *   prefix-stripping proxy: '/api/tus'), the only setting that let uploads resume before 11.42.9, was
   *   mounted as the route itself; Nest added the prefix again and every upload answered 404 at
   *   `/api/api/tus`.
   * @seen-failing Treat every configured path as a new route in TusModule.applyPath()
   *   (src/core/modules/tus/tus.module.ts) — registered as mutation `tus-path-public-url-moved` in
   *   tests/regression-mutations.json.
   */
  it("keeps the controller's route when the path is the public URL ending in it", () => {
    const module = TusModule.forRoot({ config: { path: '/api/tus' } });
    expect(Reflect.getMetadata(PATH_METADATA, CoreTusController)).toBe('tus');
    expect(tusConfigOf(module).useValue?.path).toBe('/api/tus');
  });

  it("follows a project controller's own route when no path is configured", () => {
    const module = TusModule.forRoot({ config: {}, controller: ProjectTusController });
    expect(Reflect.getMetadata(PATH_METADATA, ProjectTusController)).toBe('files/upload');
    expect(tusConfigOf(module).useValue?.path).toBe('/files/upload');
    // The core class is untouched by a subclass's route.
    expect(Reflect.getMetadata(PATH_METADATA, CoreTusController)).toBe('tus');
  });

  it('configures a disabled service as disabled, so it starts no tus server', () => {
    const service = new CoreTusService({} as never);
    service.configure(false);
    expect(service.getConfig().enabled).toBe(false);
    expect(service.isEnabled()).toBe(false);
  });
});
