/**
 * Unit Tests: `TusModule.forRoot({ service })` builds the project's subclass of `CoreTusService`.
 *
 * Before 11.41.9 both provider factories constructed `CoreTusService` directly, so a project could not
 * register a subclass at all — and the overridable hooks it carries (`onUploadCreate`,
 * `onUploadComplete`, `resolveUploadTenantId`) were unreachable. Both factories matter: the enabled
 * path is what runs, the disabled one is what a project with `tus: false` still injects.
 *
 * @regression   11.41.9 — TusModule ignored any service subclass: both factories hard-coded
 *   `new CoreTusService(...)`, so a project could not hook into upload creation or completion.
 * @seen-failing Make the module construct `CoreTusService` regardless of the option in
 *   src/core/modules/tus/tus.module.ts — registered as mutation `tus-service-option-ignored` in
 *   tests/regression-mutations.json.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { CoreTusService } from '../../src/core/modules/tus/core-tus.service';
import { TusModule } from '../../src/core/modules/tus/tus.module';

class ProjectTusService extends CoreTusService {}

/** The provider factory the module registers for `CoreTusService`. */
function serviceFactory(options: Parameters<typeof TusModule.forRoot>[0]) {
  const module = TusModule.forRoot(options);
  const provider = (module.providers ?? []).find((p: any) => p?.provide === CoreTusService) as any;
  return provider.useFactory as (...args: unknown[]) => Promise<CoreTusService> | CoreTusService;
}

describe('TusModule.forRoot({ service })', () => {
  afterEach(() => {
    TusModule.reset();
  });

  it('constructs the given subclass when TUS is enabled', async () => {
    const factory = serviceFactory({ config: { uploadDir: '/tmp/tus-seam' }, service: ProjectTusService });

    const service = await factory({} as never, { uploadDir: '/tmp/tus-seam' }, {} as never);

    expect(service).toBeInstanceOf(ProjectTusService);
  });

  it('hands the subclass a ModuleRef, so it can reach project providers at call time', async () => {
    const factory = serviceFactory({ config: { uploadDir: '/tmp/tus-seam' }, service: ProjectTusService });
    const moduleRef = { get: () => undefined };

    const service = await factory({} as never, { uploadDir: '/tmp/tus-seam' }, {}, undefined, undefined, moduleRef);

    expect((service as any).options?.moduleRef).toBe(moduleRef);
  });

  it('constructs the given subclass when TUS is disabled, too', async () => {
    const factory = serviceFactory({ config: false, service: ProjectTusService });

    expect(await factory({} as never)).toBeInstanceOf(ProjectTusService);
  });

  it('paired control: falls back to CoreTusService without the option', async () => {
    const factory = serviceFactory({ config: false });
    const service = await factory({} as never);

    expect(service).toBeInstanceOf(CoreTusService);
    expect(service).not.toBeInstanceOf(ProjectTusService);
  });
});
