import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DataSourceConfigError } from '../../src/core/common/persistence/data-source.config';
import { getStoreToken } from '../../src/core/common/persistence/persistence.tokens';
import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreTenantGuard } from '../../src/core/modules/tenant/core-tenant.guard';

/**
 * `multiTenancy.isTenantActive` receives `store(modelName)` to look the tenant up wherever `database` routes it. The
 * hook is the only thing that keeps a DEACTIVATED tenant locked, so the accessor must never let a missing model read as
 * "active".
 */
describe('isTenantActive store accessor', () => {
  let previousConfig: unknown;
  let guard: CoreTenantGuard | undefined;

  /** A guard whose application registers exactly the stores given — what `ModuleRef.get()` resolves */
  const guardWith = (stores: Record<string, unknown>) => {
    const moduleRef = {
      get: (token: string) => {
        const name = Object.keys(stores).find((model) => getStoreToken(model) === token);
        if (!name) {
          throw new Error(`Nest could not find ${token}`);
        }
        return stores[name];
      },
    };
    guard = new CoreTenantGuard({} as any, { db: {} } as any, undefined, moduleRef as any);
    clearInterval((guard as any).cleanupInterval);
    return guard as unknown as { isTenantActive(tenantId: string): Promise<boolean> };
  };

  const configure = (isTenantActive: unknown) =>
    ConfigService.setConfig({ ...(previousConfig as object), multiTenancy: { cacheTtlMs: 0, isTenantActive } } as any, {
      reInit: true,
    });

  beforeAll(() => {
    previousConfig = ConfigService.configFastButReadOnly;
  });

  afterEach(() => {
    guard?.onModuleDestroy();
    guard = undefined;
  });

  afterAll(() => {
    ConfigService.setConfig((previousConfig ?? {}) as any, { reInit: true });
  });

  it('answers from the registered store', async () => {
    configure(async (tenantId: string, { store }) => (await store('Tenant').findById(tenantId))?.active !== false);
    const tenants = { findById: async (id: string) => ({ active: id !== 'off', id }) };
    const subject = guardWith({ Tenant: tenants });

    expect(await subject.isTenantActive('on')).toBe(true);
    expect(await subject.isTenantActive('off')).toBe(false);
  });

  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — `store()` answered `undefined` for a model not registered with
   *   `CorePersistenceModule.forFeature()` (the default layout `lt server module` generates registers it with
   *   `MongooseModule.forFeature()`), and the documented hook `store('Tenant')?.findById(id)` then read every
   *   deactivated tenant as active.
   * @seen-failing Return `store` without the unregistered-model check in CoreTenantGuard.storeOf in
   *   src/core/modules/tenant/core-tenant.guard.ts — registered as mutation `tenant-store-accessor-answers-undefined`
   *   in tests/regression-mutations.json.
   */
  it('refuses instead of answering "active" when the hook asks for a model that is not registered', async () => {
    // Written with `?.`, as a project would — the accessor must fail closed whatever the hook does with its answer
    configure(async (tenantId: string, { store }) => (await store('Tenant')?.findById(tenantId))?.active !== false);
    const subject = guardWith({});

    await expect(subject.isTenantActive('off')).rejects.toThrow(DataSourceConfigError);
    await expect(subject.isTenantActive('off')).rejects.toThrow(/'Tenant'.*not registered/);
  });
});
