import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreAiConnectionService } from '../../src/core/modules/ai/services/core-ai-connection.service';

/**
 * Unit coverage for the boot self-checks of {@link CoreAiConnectionService}.
 *
 * These live in the UNIT suite on purpose: the e2e runner sets `NODE_ENV=e2e`, which the
 * drift check skips by design, so the method body can only be exercised here (mocked
 * providerFactory, no real network). This is the test that makes the "declared vs. probed"
 * drift logic observable — a check that only compares DECLARED flags is worthless unless
 * the provider is forced to probe them, which is exactly what `warnOnCapabilityDrift` now does.
 */
describe('CoreAiConnectionService (unit)', () => {
  let originalNodeEnv: string | undefined;

  const crypto = {
    decrypt: (v: string) => `plain:${v}`,
    encrypt: (v: string) => `enc:${v}`,
  } as any;

  function buildService(opts: { providerFactory?: any } = {}) {
    const state: { count: number; findDocs: any[] } = { count: 0, findDocs: [] };
    const model = {
      countDocuments: vi.fn(() => ({ exec: () => Promise.resolve(state.count) })),
      create: vi.fn((doc: any) => Promise.resolve({ ...doc, _id: 'seeded' })),
      find: vi.fn(() => ({ lean: () => ({ exec: () => Promise.resolve(state.findDocs) }) })),
      findByIdAndUpdate: vi.fn(() => ({ exec: () => Promise.resolve({}) })),
    } as any;
    const service = new CoreAiConnectionService(crypto, model, {} as any, undefined, opts.providerFactory);
    const warn = vi.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
    return { log, model, service, state, warn };
  }

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test'; // not ci/e2e → the drift body runs
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
  });

  describe('warnOnCapabilityDrift', () => {
    const providerFactoryReturning = (detected: any) => ({
      create: vi.fn(() => ({ detectCapabilities: vi.fn(() => Promise.resolve(detected)) })),
    });

    it('warns on native-tools drift and probes with the declared flags cleared', async () => {
      ConfigService.setConfig({ ai: { capabilityDriftCheck: true } } as any, { reInit: true });
      const providerFactory = providerFactoryReturning({ nativeTools: true });
      const { service, state, warn } = buildService({ providerFactory });
      state.findDocs = [{ _id: '1', baseUrl: 'http://x', model: 'm', name: 'C', supportsNativeTools: false }];

      await (service as any).warnOnCapabilityDrift();

      // H1: the declared flags must be cleared so detectCapabilities() actually probes them.
      const probeArg = (providerFactory.create as any).mock.calls[0][0];
      expect(probeArg.supportsNativeTools).toBeUndefined();
      expect(probeArg.supportsJsonResponse).toBeUndefined();
      expect(probeArg.baseUrl).toBe('http://x');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('capability drift');
      expect(warn.mock.calls[0][0]).toContain('supportsNativeTools declared false but the endpoint reports true');
    });

    it('warns on json-response drift', async () => {
      ConfigService.setConfig({ ai: { capabilityDriftCheck: true } } as any, { reInit: true });
      const { service, state, warn } = buildService({
        providerFactory: providerFactoryReturning({ jsonResponse: false }),
      });
      state.findDocs = [{ _id: '1', baseUrl: 'http://x', model: 'm', name: 'C', supportsJsonResponse: true }];

      await (service as any).warnOnCapabilityDrift();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('supportsJsonResponse declared true but the endpoint reports false');
    });

    it('does not warn when the declared value matches the probe', async () => {
      ConfigService.setConfig({ ai: { capabilityDriftCheck: true } } as any, { reInit: true });
      const { service, state, warn } = buildService({
        providerFactory: providerFactoryReturning({ nativeTools: false }),
      });
      state.findDocs = [{ _id: '1', baseUrl: 'http://x', model: 'm', name: 'C', supportsNativeTools: false }];

      await (service as any).warnOnCapabilityDrift();

      expect(warn).not.toHaveBeenCalled();
    });

    it('is a no-op when the opt-in flag is not set (default off) — never reads the DB', async () => {
      ConfigService.setConfig({ ai: {} } as any, { reInit: true });
      const providerFactory = providerFactoryReturning({ nativeTools: true });
      const { model, service, warn } = buildService({ providerFactory });

      await (service as any).warnOnCapabilityDrift();

      expect(model.find).not.toHaveBeenCalled();
      expect(providerFactory.create).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('skips connections that declare neither flag (nothing to reconcile)', async () => {
      ConfigService.setConfig({ ai: { capabilityDriftCheck: true } } as any, { reInit: true });
      const providerFactory = providerFactoryReturning({ nativeTools: true });
      const { service, state, warn } = buildService({ providerFactory });
      state.findDocs = [{ _id: '1', baseUrl: 'http://x', model: 'm', name: 'C' }];

      await (service as any).warnOnCapabilityDrift();

      expect(providerFactory.create).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('returns without reading the DB when no provider factory is available', async () => {
      ConfigService.setConfig({ ai: { capabilityDriftCheck: true } } as any, { reInit: true });
      const { model, service } = buildService({ providerFactory: undefined });

      await (service as any).warnOnCapabilityDrift();

      expect(model.find).not.toHaveBeenCalled();
    });

    it('continues past a connection whose provider cannot be built', async () => {
      ConfigService.setConfig({ ai: { capabilityDriftCheck: true } } as any, { reInit: true });
      const providerFactory = {
        create: vi.fn(() => {
          throw new Error('unbuildable');
        }),
      };
      const { service, state, warn } = buildService({ providerFactory });
      state.findDocs = [{ _id: '1', baseUrl: 'http://x', model: 'm', name: 'C', supportsNativeTools: false }];

      await expect((service as any).warnOnCapabilityDrift()).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it('treats a failed probe as no-drift, never a signal', async () => {
      ConfigService.setConfig({ ai: { capabilityDriftCheck: true } } as any, { reInit: true });
      const providerFactory = {
        create: vi.fn(() => ({ detectCapabilities: vi.fn(() => Promise.reject(new Error('endpoint down'))) })),
      };
      const { service, state, warn } = buildService({ providerFactory });
      state.findDocs = [{ _id: '1', baseUrl: 'http://x', model: 'm', name: 'C', supportsNativeTools: false }];

      await expect((service as any).warnOnCapabilityDrift()).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it('never throws and logs a skip message when the bulk read fails', async () => {
      ConfigService.setConfig({ ai: { capabilityDriftCheck: true } } as any, { reInit: true });
      const providerFactory = providerFactoryReturning({ nativeTools: true });
      const { model, service, warn } = buildService({ providerFactory });
      (model.find as any).mockImplementation(() => ({ lean: () => ({ exec: () => Promise.reject(new Error('db gone')) }) }));

      await expect((service as any).warnOnCapabilityDrift()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('drift check skipped');
    });
  });

  describe('seedDefaultConnection', () => {
    it('maps a configured contextWindow into the created connection and encrypts the key', async () => {
      ConfigService.setConfig(
        { ai: { defaultConnection: { apiKey: 'sk', baseUrl: 'http://x', contextWindow: 32768, model: 'm', name: 'C' } } } as any,
        { reInit: true },
      );
      const { model, service, state } = buildService();
      state.count = 0;

      await (service as any).seedDefaultConnection();

      expect(model.create).toHaveBeenCalledTimes(1);
      const created = (model.create as any).mock.calls[0][0];
      expect(created).toMatchObject({ contextWindow: 32768, isDefault: true, providerType: 'openai-compatible' });
      expect(created.apiKeyEncrypted).toBe('enc:sk');
      expect(created.apiKey).toBeUndefined();
    });
  });
});
