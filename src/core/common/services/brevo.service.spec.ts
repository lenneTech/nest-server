import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Brevo, BrevoClient as RealBrevoClient } from '@getbrevo/brevo';

import { BrevoService } from './brevo.service';
import type { ConfigService } from './config.service';

/**
 * Type-level contract against the REAL SDK.
 *
 * Everything below runs against a hand-written mock, so the mock alone could keep passing after a
 * breaking SDK upgrade. `sendMail()` is declared `Promise<unknown>`, which gives tsc nothing to
 * check either. These assertions close that gap: they compile against the installed
 * `@getbrevo/brevo`, and `pnpm run typecheck:tests` covers `src/**\/*.spec.ts`, so a v7 that
 * re-introduces a `.body` envelope or renames the request type fails the build here rather than
 * silently at runtime.
 */
type SendFn = RealBrevoClient['transactionalEmails']['sendTransacEmail'];
/** Awaiting the call must yield the payload itself — v3's `{ response, body }` envelope is gone. */
type AssertNoEnvelope = Awaited<ReturnType<SendFn>> extends { body: unknown } ? never : true;
/** The request type the service builds must still be assignable to the SDK's parameter. */
type AssertRequestType = Brevo.SendTransacEmailRequest extends NonNullable<Parameters<SendFn>[0]> ? true : never;
// Consumed by an assertion below so the contract cannot be dead-code-eliminated or linted away.
const sdkContract: [AssertNoEnvelope, AssertRequestType] = [true, true];

/**
 * Shared handles into the mocked SDK. `vi.hoisted` runs before the `vi.mock` factory below, so the
 * spies exist by the time the module graph is wired up.
 */
const brevoMock = vi.hoisted(() => ({
  /** Every options object the client was constructed with, in call order. */
  clientOptions: [] as unknown[],
  sendTransacEmail: vi.fn(),
}));

vi.mock('@getbrevo/brevo', () => ({
  BrevoClient: class {
    transactionalEmails = { sendTransacEmail: brevoMock.sendTransacEmail };

    constructor(options: unknown) {
      brevoMock.clientOptions.push(options);
    }
  },
}));

const API_KEY = 'test-api-key';
const SENDER = { email: 'noreply@test.com', name: 'Test Sender' };

/** Matches the per-send `Idempotency-Key` header without pinning the random UUID. */
const anyIdempotencyHeaders = { 'Idempotency-Key': expect.any(String) as unknown as string };

/**
 * Minimal ConfigService double.
 *
 * `exclude` can be set independently on the mutable (`config`) and the frozen
 * (`configFastButReadOnly`) side so the tests can prove which one the service reads.
 */
function makeConfigService(
  options: {
    exclude?: RegExp;
    frozenExclude?: RegExp;
    maxRetries?: number;
    throwOnError?: boolean;
    timeoutInSeconds?: number;
    withBrevo?: boolean;
  } = {},
): ConfigService {
  const { exclude, frozenExclude = exclude, maxRetries, throwOnError, timeoutInSeconds, withBrevo = true } = options;
  const base = { apiKey: API_KEY, maxRetries, sender: SENDER, throwOnError, timeoutInSeconds };
  return {
    config: withBrevo ? { brevo: { ...base, exclude } } : {},
    configFastButReadOnly: withBrevo ? { brevo: { ...base, exclude: frozenExclude } } : {},
  } as unknown as ConfigService;
}

describe('@getbrevo/brevo SDK contract', () => {
  it('still resolves the payload directly and accepts the request type we build', () => {
    // The assertion is the COMPILATION of `sdkContract` above, which `pnpm run typecheck:tests`
    // performs against the really installed SDK. This test body exists so the contract is also
    // referenced at runtime — otherwise it reads as dead code and invites deletion.
    expect(sdkContract).toEqual([true, true]);
  });
});

describe('BrevoService', () => {
  let loggerError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    brevoMock.sendTransacEmail.mockReset();
    brevoMock.clientOptions.length = 0;
    loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // The spies above are never restored otherwise. File-level isolation contains it today, but a
    // leaked Logger spy is the kind of thing that only surfaces as an unrelated flake later.
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('throws when the Brevo configuration is missing', () => {
      expect(() => new BrevoService(makeConfigService({ withBrevo: false }))).toThrow('Brevo configuration not set!');
    });

    it('does NOT construct the SDK client eagerly', async () => {
      // The SDK is ~580 CommonJS modules and BrevoService is re-exported from the package barrel,
      // so a static import would put that cost on every consumer's cold start — including the
      // majority that never configure Brevo.
      const service = new BrevoService(makeConfigService());
      expect(brevoMock.clientOptions).toEqual([]);

      brevoMock.sendTransacEmail.mockResolvedValue({ messageId: '<x@brevo>' });
      await service.sendMail('user@example.com', 42);
      expect(brevoMock.clientOptions).toHaveLength(1);
    });

    it('creates the client with the configured API key and safe request limits', async () => {
      brevoMock.sendTransacEmail.mockResolvedValue({ messageId: '<x@brevo>' });
      const service = new BrevoService(makeConfigService());
      await service.sendMail('user@example.com', 42);

      // The SDK defaults to 2 retries honouring `Retry-After` with a 60 s cap PER attempt and to
      // no timeout at all. Both send methods are awaited inside request handlers, so those
      // defaults would let a rate-limited Brevo park a user-facing request for ~2 minutes.
      expect(brevoMock.clientOptions).toEqual([{ apiKey: API_KEY, maxRetries: 0, timeoutInSeconds: 10 }]);
    });

    it('honours configured retry and timeout overrides', async () => {
      brevoMock.sendTransacEmail.mockResolvedValue({ messageId: '<x@brevo>' });
      const service = new BrevoService(makeConfigService({ maxRetries: 3, timeoutInSeconds: 30 }));
      await service.sendMail('user@example.com', 42);
      expect(brevoMock.clientOptions).toEqual([{ apiKey: API_KEY, maxRetries: 3, timeoutInSeconds: 30 }]);
    });

    it('reuses the client across sends', async () => {
      brevoMock.sendTransacEmail.mockResolvedValue({ messageId: '<x@brevo>' });
      const service = new BrevoService(makeConfigService());
      await service.sendMail('user@example.com', 42);
      await service.sendMail('other@example.com', 42);
      expect(brevoMock.clientOptions).toHaveLength(1);
    });
  });

  describe('sendMail', () => {
    it('rejects incomplete input without calling the API', async () => {
      const service = new BrevoService(makeConfigService());
      await expect(service.sendMail('', 42)).resolves.toBe(false);
      await expect(service.sendMail('user@example.com', 0)).resolves.toBe(false);
      expect(brevoMock.sendTransacEmail).not.toHaveBeenCalled();
    });

    it('sends template, recipient and params, and returns the response unwrapped', async () => {
      const response = { messageId: '<mail-1@brevo>' };
      brevoMock.sendTransacEmail.mockResolvedValue(response);
      const service = new BrevoService(makeConfigService());

      // Identity check: v6 resolves the payload directly, there is no `.body` envelope any more
      await expect(service.sendMail('user@example.com', 42, { name: 'Test' })).resolves.toBe(response);
      expect(brevoMock.sendTransacEmail).toHaveBeenCalledWith({
        headers: anyIdempotencyHeaders,
        params: { name: 'Test' },
        templateId: 42,
        to: [{ email: 'user@example.com' }],
      });
    });

    it('sends a unique Idempotency-Key per call', async () => {
      // The SDK retries POSTs on 408/429/5xx. Without a key, a retry issued after a delivered
      // response whose reply was lost sends the mail twice.
      brevoMock.sendTransacEmail.mockResolvedValue({ messageId: '<x@brevo>' });
      const service = new BrevoService(makeConfigService());
      await service.sendMail('user@example.com', 42);
      await service.sendMail('user@example.com', 42);

      const keys = brevoMock.sendTransacEmail.mock.calls.map(
        ([request]) => (request as Brevo.SendTransacEmailRequest).headers?.['Idempotency-Key'],
      );
      expect(keys[0]).toBeTypeOf('string');
      expect(keys[0]).not.toBe(keys[1]);
    });

    it('skips excluded (test) recipients', async () => {
      const service = new BrevoService(makeConfigService({ exclude: /@test\.com$/i }));
      await expect(service.sendMail('user@test.com', 42)).resolves.toBe('TEST_USER!');
      expect(brevoMock.sendTransacEmail).not.toHaveBeenCalled();
    });

    it('reads the exclude pattern from the mutable config, not the frozen one', async () => {
      // A frozen RegExp carrying the `g` flag throws on `.test()` (it assigns `lastIndex`).
      // Reading `exclude` off `configFastButReadOnly` would therefore fail instead of excluding.
      const service = new BrevoService(
        makeConfigService({ exclude: /@test\.com$/i, frozenExclude: Object.freeze(/@test\.com$/gi) }),
      );
      await expect(service.sendMail('user@test.com', 42)).resolves.toBe('TEST_USER!');
    });

    it('returns null when the API call fails', async () => {
      brevoMock.sendTransacEmail.mockRejectedValue(new Error('Brevo down'));
      const service = new BrevoService(makeConfigService());
      await expect(service.sendMail('user@example.com', 42)).resolves.toBeNull();
    });

    it('logs the failure through the Nest logger', async () => {
      // The whole point of the sibling diagnostics work is that silent failures cost debugging
      // sessions. Asserting only the `null` return would let the observability half regress.
      brevoMock.sendTransacEmail.mockRejectedValue(new Error('Brevo down'));
      const service = new BrevoService(makeConfigService());
      await service.sendMail('user@example.com', 42);
      expect(loggerError).toHaveBeenCalledWith(expect.stringContaining('Brevo down'));
    });

    it('rethrows when throwOnError is enabled', async () => {
      const service = new BrevoService(makeConfigService({ throwOnError: true }));
      brevoMock.sendTransacEmail.mockRejectedValue(new Error('Brevo down'));
      await expect(service.sendMail('user@example.com', 42)).rejects.toThrow('Brevo down');
    });
  });

  describe('sendHtmlMail', () => {
    it('rejects incomplete input without calling the API', async () => {
      const service = new BrevoService(makeConfigService());
      await expect(service.sendHtmlMail('', 'Subject', '<p>Hi</p>')).resolves.toBe(false);
      await expect(service.sendHtmlMail('user@example.com', '', '<p>Hi</p>')).resolves.toBe(false);
      await expect(service.sendHtmlMail('user@example.com', 'Subject', '')).resolves.toBe(false);
      expect(brevoMock.sendTransacEmail).not.toHaveBeenCalled();
    });

    it('sends html, subject and the configured sender, and returns the response unwrapped', async () => {
      const response = { messageId: '<mail-2@brevo>' };
      brevoMock.sendTransacEmail.mockResolvedValue(response);
      const service = new BrevoService(makeConfigService());

      await expect(
        service.sendHtmlMail('user@example.com', 'Subject', '<p>Hi</p>', { params: { code: '123' } }),
      ).resolves.toBe(response);
      expect(brevoMock.sendTransacEmail).toHaveBeenCalledWith({
        headers: anyIdempotencyHeaders,
        htmlContent: '<p>Hi</p>',
        params: { code: '123' },
        sender: SENDER,
        subject: 'Subject',
        to: [{ email: 'user@example.com' }],
      });
    });

    it('skips excluded (test) recipients', async () => {
      const service = new BrevoService(makeConfigService({ exclude: /@test\.com$/i }));
      await expect(service.sendHtmlMail('user@test.com', 'Subject', '<p>Hi</p>')).resolves.toBe('TEST_USER!');
      expect(brevoMock.sendTransacEmail).not.toHaveBeenCalled();
    });

    it('returns null when the API call fails', async () => {
      brevoMock.sendTransacEmail.mockRejectedValue(new Error('Brevo down'));
      const service = new BrevoService(makeConfigService());
      await expect(service.sendHtmlMail('user@example.com', 'Subject', '<p>Hi</p>')).resolves.toBeNull();
    });

    it('logs the failure through the Nest logger', async () => {
      brevoMock.sendTransacEmail.mockRejectedValue(new Error('Brevo down'));
      const service = new BrevoService(makeConfigService());
      await service.sendHtmlMail('user@example.com', 'Subject', '<p>Hi</p>');
      expect(loggerError).toHaveBeenCalledWith(expect.stringContaining('Brevo down'));
    });
  });
});
