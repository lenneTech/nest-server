/**
 * The AI SDK transport (nestjs-ai plan §2): `AiSdkProvider`, the `nestjs-ai` provider type, project-registered AI SDK
 * model builders, the egress allowlist on every path it constructs, and the version gate of the 0.x packages.
 */
import { INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AiModule } from '@nestjs/ai';
import { FakeModel } from '@nestjs/ai/testing';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { OutboundUrlBlockedError } from '../../src/core/common/helpers/outbound-url.helper';
import { ConfigService } from '../../src/core/common/services/config.service';
import { ResolvedAiConnection } from '../../src/core/modules/ai/interfaces/resolved-ai-connection.interface';
import { createAiEgressFetch } from '../../src/core/modules/ai/providers/ai-egress.helper';
import {
  AiSdkPackageError,
  assertAiSdkPackage,
  isTestedAiSdkVersion,
} from '../../src/core/modules/ai/providers/ai-sdk.packages';
import {
  AI_SDK_MAX_ATTACHMENT_DOWNLOADS,
  AiSdkProvider,
  mapAiSdkUsage,
  readBodyWithLimit,
} from '../../src/core/modules/ai/providers/ai-sdk.provider';
import { LlmProviderFactory } from '../../src/core/modules/ai/providers/llm-provider.factory';

function connection(overrides: Partial<ResolvedAiConnection> = {}): ResolvedAiConnection {
  return {
    apiKey: 'key',
    baseUrl: 'nestjs-ai:default',
    id: 'c1',
    model: 'default',
    name: 'Test connection',
    providerType: 'nestjs-ai',
    ...overrides,
  };
}

const TOOLS = [
  {
    description: 'Find a ticket',
    name: 'find_ticket',
    parameters: { properties: { id: { type: 'string' } }, required: ['id'], type: 'object' },
  },
];

describe('AiSdkProvider', () => {
  beforeEach(() => {
    ConfigService.setConfig({ env: 'local' } as any, { reInit: true, warn: false });
  });

  afterEach(() => {
    ConfigService.setConfig({} as any, { reInit: true, warn: false });
  });

  /**
   * @regression   12.10.0 — the AI SDK runs a tool itself as soon as it has an `execute`; then the model's tool call
   *   would bypass every gate of CoreAiService (role filter, policies, authorize(), confirmation, plan mode, budget).
   * @seen-failing Give each native tool an `execute` in AiSdkProvider.buildRequest() in
   *   src/core/modules/ai/providers/ai-sdk.provider.ts — registered as mutation `ai-sdk-tools-carry-execute` in
   *   tests/regression-mutations.json.
   */
  it('hands native tools to the model without execute and returns the calls instead of running them', async () => {
    const model = new FakeModel([
      { toolCalls: [{ input: { id: 'T-1' }, name: 'find_ticket' }], usage: { inputTokens: 12, outputTokens: 3 } },
    ]);
    const provider = new AiSdkProvider(connection({ providerType: 'test' }), { model: () => model as any });

    const sdk = await import('ai');
    const request = (provider as any).buildRequest(sdk, model, [], TOOLS);
    expect(Object.keys(request.tools)).toEqual(['find_ticket']);
    expect(Object.values(request.tools).every((tool: any) => !('execute' in tool))).toBe(true);

    const response = await provider.chat(
      [
        { content: 'You are helpful.', role: 'system' },
        { content: 'Find T-1', role: 'user' },
      ],
      TOOLS,
    );
    expect(response.toolCalls).toEqual([{ arguments: { id: 'T-1' }, id: expect.any(String), name: 'find_ticket' }]);
    expect(response.usage).toMatchObject({ completionTokens: 3, promptTokens: 12, totalTokens: 15 });
    expect(model.lastCall?.instructions).toContain('You are helpful.');
    expect(model.lastCall?.tools).toEqual(['find_ticket']);
  });

  it('answers text and maps the usage the provider reports', async () => {
    const model = new FakeModel([{ text: 'Hello', usage: { inputTokens: 4, outputTokens: 2, reasoningTokens: 1 } }]);
    const provider = new AiSdkProvider(connection({ providerType: 'test' }), { model: () => model as any });
    const response = await provider.chat([{ content: 'Hi', role: 'user' }], []);
    expect(response.text).toBe('Hello');
    expect(response.toolCalls).toBeUndefined();
    expect(response.usage?.promptTokens).toBe(4);
    expect(mapAiSdkUsage(undefined)).toBeUndefined();
  });

  it('reports a failing model as an unavailable connection', async () => {
    const model = new FakeModel([new Error('provider exploded')]);
    const provider = new AiSdkProvider(connection({ providerType: 'test' }), { model: () => model as any });
    await expect(provider.chat([{ content: 'Hi', role: 'user' }], [])).rejects.toThrow(/LTNS_/);
  });

  /**
   * @regression   12.10.0 — the AI SDK downloads an attachment URL the model cannot read itself with its own `fetch`;
   *   attachment URLs come from the user, so that was a server-side request to any address, internal ones included.
   * @seen-failing Replace `outboundFetch(` with `fetch(` in AiSdkProvider.downloadAttachments() in
   *   src/core/modules/ai/providers/ai-sdk.provider.ts — registered as mutation `ai-sdk-attachment-download-unguarded`
   *   in tests/regression-mutations.json.
   */
  it('downloads attachments only through the outbound URL guard', async () => {
    ConfigService.setConfig({ env: 'production', security: { allowPrivateOutboundTargets: false } } as any, {
      reInit: true,
      warn: false,
    });
    const provider = new AiSdkProvider(connection({ providerType: 'test' }), { model: () => ({}) as any });
    await expect(
      (provider as any).downloadAttachments([{ isUrlSupportedByModel: false, url: new URL('http://127.0.0.1:9/x.png') }]),
    ).rejects.toBeInstanceOf(OutboundUrlBlockedError);
    await expect(
      (provider as any).downloadAttachments([{ isUrlSupportedByModel: true, url: new URL('http://127.0.0.1:9/x.png') }]),
    ).resolves.toEqual([null]);
  });
});

describe('createAiEgressFetch', () => {
  afterEach(() => {
    ConfigService.setConfig({} as any, { reInit: true, warn: false });
  });

  /**
   * @regression   12.10.0 — a model provider a project builds with the AI SDK sends its requests through the `fetch` it
   *   is given; without the guard, `ai.allowedBaseUrlHosts` covered the built-in provider only.
   * @seen-failing Drop the assertAiEgressAllowed() call from createAiEgressFetch() in
   *   src/core/modules/ai/providers/ai-egress.helper.ts — registered as mutation `ai-egress-fetch-unguarded` in
   *   tests/regression-mutations.json.
   */
  it('refuses a host outside ai.allowedBaseUrlHosts before sending, and passes a listed one', async () => {
    ConfigService.setConfig({ ai: { allowedBaseUrlHosts: 'api.allowed.test' } } as any, { reInit: true, warn: false });
    const base = vi.fn(async () => new Response('ok'));
    const guarded = createAiEgressFetch('Anthropic', base as unknown as typeof fetch);
    await expect(guarded('https://evil.test/v1/messages')).rejects.toThrow(/LTNS_/);
    expect(base).not.toHaveBeenCalled();
    await expect(guarded(new URL('https://api.allowed.test/v1/messages'))).resolves.toBeInstanceOf(Response);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('is permissive while no allowlist is configured', async () => {
    const base = vi.fn(async () => new Response('ok'));
    await createAiEgressFetch('x', base as unknown as typeof fetch)('http://localhost:11434/api');
    expect(base).toHaveBeenCalledTimes(1);
  });
});

describe('the 0.x package gate', () => {
  /**
   * @regression   12.10.0 — an untested `@nestjs/ai` release must stop with an error naming the tested range, not run
   *   with whatever its 0.x API became.
   * @seen-failing Make isTestedAiSdkVersion() in src/core/modules/ai/providers/ai-sdk.packages.ts accept any version —
   *   registered as mutation `ai-sdk-version-gate-open` in tests/regression-mutations.json.
   */
  it('accepts the tested range and refuses everything else with the range named', () => {
    expect(isTestedAiSdkVersion('@nestjs/ai', '0.0.2')).toBe(true);
    expect(isTestedAiSdkVersion('@nestjs/ai', '0.0.3')).toBe(false);
    expect(isTestedAiSdkVersion('@nestjs/ai', '0.0.2-beta.1')).toBe(false);
    expect(isTestedAiSdkVersion('ai', '7.0.173')).toBe(true);
    expect(isTestedAiSdkVersion('ai', '8.0.0')).toBe(false);
    expect(() => assertAiSdkPackage('@nestjs/ai', {}, '0.1.0')).toThrow(/tested with @nestjs\/ai >=0\.0\.2 <0\.0\.3/);
  });

  it('refuses a release that lacks a member the framework calls', async () => {
    const real = await import('@nestjs/ai');
    expect(() => assertAiSdkPackage('@nestjs/ai', real, '0.0.2')).not.toThrow();
    expect(() => assertAiSdkPackage('@nestjs/ai', { AiModels: real.AiModels }, '0.0.2')).toThrow(AiSdkPackageError);
  });
});

describe('providerType "nestjs-ai"', () => {
  let app: INestApplication;
  const model = new FakeModel([{ text: 'from @nestjs/ai', usage: { inputTokens: 1, outputTokens: 1 } }]);

  beforeEach(async () => {
    @Module({ imports: [AiModule.forRoot({ models: { default: model } })], providers: [LlmProviderFactory] })
    class NestjsAiModule {}
    const moduleRef = await Test.createTestingModule({ imports: [NestjsAiModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('calls the model registered in AiModule.forRoot({ models }) through @nestjs/resilience', async () => {
    const provider = app.get(LlmProviderFactory).create(connection());
    const response = await provider.chat([{ content: 'Hi', role: 'user' }], []);
    expect(response.text).toBe('from @nestjs/ai');
  });

  it('names a model the application does not register', async () => {
    const provider = app.get(LlmProviderFactory).create(connection({ model: 'missing' }));
    await expect(provider.chat([{ content: 'Hi', role: 'user' }], [])).rejects.toThrow(/"missing"/);
  });

  /**
   * @regression   12.10.0 — `ai.allowedBaseUrlHosts` covers a project-built AI SDK provider only through the `fetch` the
   *   builder receives; handing it the global fetch would switch the allowlist off for every such connection.
   * @seen-failing Pass `fetch` instead of `createAiEgressFetch(connection.name)` in
   *   LlmProviderFactory.registerAiSdkModel() in src/core/modules/ai/providers/llm-provider.factory.ts — registered as
   *   mutation `ai-sdk-builder-fetch-unguarded` in tests/regression-mutations.json.
   */
  it('registers AI SDK model builders that receive the guarded fetch', async () => {
    ConfigService.setConfig({ ai: { allowedBaseUrlHosts: 'api.allowed.test' } } as any, { reInit: true, warn: false });
    const factory = app.get(LlmProviderFactory);
    let refused: unknown;
    const builder = vi.fn(async (_connection: ResolvedAiConnection, context: { fetch: typeof fetch }) => {
      refused = await context.fetch('https://evil.test/v1').catch((error: unknown) => error);
      return new FakeModel([{ text: 'built' }]) as any;
    });
    await factory.registerAiSdkModel('anthropic', builder);
    const response = await factory.create(connection({ providerType: 'anthropic' })).chat([{ content: 'x', role: 'user' }], []);
    expect(response.text).toBe('built');
    expect(builder).toHaveBeenCalledTimes(1);
    expect(String(refused)).toMatch(/LTNS_/);
    ConfigService.setConfig({} as any, { reInit: true, warn: false });
  });
});

describe('AiSdkProvider attachment downloads', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    // A chunked body without Content-Length, 25 MB long — larger than one attachment may be
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(1024 * 1024, 1);
      let sent = 0;
      const pump = () => {
        while (sent < 25) {
          sent++;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ConfigService.setConfig({} as any, { reInit: true, warn: false });
  });

  /**
   * @regression   12.10.0 — the download read `response.arrayBuffer()` and checked the size afterwards: a body without
   *   Content-Length (or a compressed one) was held in memory in full, so one prompt attachment pointing at an endless
   *   stream ran the API out of memory. The AI SDK's own download, which this hook replaces, stops at 100 MiB.
   * @seen-failing Read the body with `new Uint8Array(await response.arrayBuffer())` instead of readBodyWithLimit() in
   *   AiSdkProvider.downloadAttachments() in src/core/modules/ai/providers/ai-sdk.provider.ts — registered as mutation
   *   `ai-sdk-attachment-read-unbounded` in tests/regression-mutations.json.
   */
  it('stops reading a body without Content-Length at the size limit', async () => {
    ConfigService.setConfig({ env: 'local', security: { allowPrivateOutboundTargets: true } } as any, {
      reInit: true,
      warn: false,
    });
    const provider = new AiSdkProvider(connection({ providerType: 'test' }), { model: () => ({}) as any });
    await expect(
      (provider as any).downloadAttachments([{ isUrlSupportedByModel: false, url: new URL(`${base}/endless`) }]),
    ).rejects.toThrow('Attachment too large');
  });

  it('refuses more attachment downloads than one call may make, before fetching any', async () => {
    const provider = new AiSdkProvider(connection({ providerType: 'test' }), { model: () => ({}) as any });
    const requests = Array.from({ length: AI_SDK_MAX_ATTACHMENT_DOWNLOADS + 1 }, (_, i) => ({
      isUrlSupportedByModel: false,
      url: new URL(`${base}/${i}`),
    }));
    await expect((provider as any).downloadAttachments(requests)).rejects.toThrow(/Too many attachments/);
  });

  it('enforces the per-call budget across downloads', async () => {
    const chunks = [new Uint8Array(6), new Uint8Array(6)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) {
          controller.enqueue(next);
        } else {
          controller.close();
        }
      },
    });
    await expect(readBodyWithLimit(stream, 100, { remaining: 10 })).rejects.toThrow('Attachment too large');
  });

  /**
   * @regression   12.10.0 — the guarded download only protects anything while `buildRequest()` hands it to the AI SDK;
   *   without it the SDK downloads user-supplied attachment URLs with its own fetch.
   * @seen-failing Drop `experimental_download` from AiSdkProvider.buildRequest() in
   *   src/core/modules/ai/providers/ai-sdk.provider.ts — registered as mutation `ai-sdk-download-hook-unwired` in
   *   tests/regression-mutations.json.
   */
  it('wires the guarded download into every generateText() call', async () => {
    ConfigService.setConfig({ env: 'production', security: { allowPrivateOutboundTargets: false } } as any, {
      reInit: true,
      warn: false,
    });
    const provider = new AiSdkProvider(connection({ providerType: 'test' }), { model: () => ({}) as any });
    const request = (provider as any).buildRequest(await import('ai'), {}, [{ content: 'x', role: 'user' }], []);
    expect(typeof request.experimental_download).toBe('function');
    await expect(
      request.experimental_download([{ isUrlSupportedByModel: false, url: new URL('http://127.0.0.1:9/x.png') }]),
    ).rejects.toBeInstanceOf(OutboundUrlBlockedError);
  });
});
