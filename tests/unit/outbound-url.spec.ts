import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  assertOutboundUrlAllowed,
  createOutboundDispatcher,
  isBlockedOutboundAddress,
  outboundFetch,
  OutboundUrlBlockedError,
  privateOutboundTargetsAllowed,
} from '../../src/core/common/helpers/outbound-url.helper';
import { ConfigService } from '../../src/core/common/services/config.service';

/**
 * Unit Tests: requests to a URL a USER entered — webhooks, export targets, an ERP address.
 *
 * The server calls such a URL from inside its own network. Without a check, a user points it at the
 * neighbourhood — the database, other containers, the cloud metadata service — and, wherever the
 * response is shown back, reads the answer (SSRF). The check runs twice: on the URL before anything is
 * sent (a readable error), and on every connection through the dispatcher, which is what catches a
 * redirect or a DNS answer that changes between the two (rebinding).
 *
 * Only for URLs from users. Configured targets (AI providers, SMTP, S3, Redis) do not use it.
 *
 * @regression   11.42.0 — no framework helper refused internal targets for user-entered URLs; projects
 *   built their own, and a hand-rolled check misses IPv4-mapped IPv6, redirects and rebinding.
 * @seen-failing Make `isBlockedOutboundAddress()` answer false for every address in
 *   src/core/common/helpers/outbound-url.helper.ts — registered as mutation
 *   `outbound-url-blocklist-empty` in tests/regression-mutations.json.
 */
describe('outbound URL guard', () => {
  let previousConfig: unknown;
  const savedNodeEnv = process.env.NODE_ENV;

  const configure = (security: Record<string, unknown> = {}, env?: string) =>
    ConfigService.setConfig(
      { ...(previousConfig as object), ...(env ? { env } : {}), security: { ...security } } as any,
      { reInit: true },
    );

  beforeAll(() => {
    previousConfig = ConfigService.configFastButReadOnly;
  });

  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv;
    ConfigService.setConfig((previousConfig ?? {}) as any, { reInit: true });
  });

  describe('which addresses are internal', () => {
    it.each([
      '127.0.0.1',
      '10.0.3.7',
      '172.16.0.1',
      '192.168.2.114',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '198.18.0.1',
      '224.0.0.1',
      '::1',
      '::',
      '::127.0.0.1',
      'fd00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:7f00:1',
      '[::1]',
    ])('blocks %s', (address) => {
      expect(isBlockedOutboundAddress(address)).toBe(true);
    });

    it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111'])('allows %s', (address) => {
      expect(isBlockedOutboundAddress(address)).toBe(false);
    });
  });

  describe('who may reach internal targets', () => {
    /**
     * @regression   11.42.0 (found in review) — `test` counted as a local environment, but in projects
     *   built from nest-server-starter `test` is a DEPLOYED stage, where the guard was then off.
     * @seen-failing Add 'test' back to LOCAL_ENVIRONMENTS in
     *   src/core/common/helpers/outbound-url.helper.ts — registered as mutation
     *   `outbound-url-test-stage-local` in tests/regression-mutations.json.
     */
    it('refuses them on every deployed stage, including `test`, and allows them locally, in e2e and CI', () => {
      for (const env of ['production', 'staging', 'develop', 'test']) {
        configure({}, env);
        expect(privateOutboundTargetsAllowed(), env).toBe(false);
      }
      for (const env of ['local', 'e2e', 'ci']) {
        configure({}, env);
        expect(privateOutboundTargetsAllowed(), env).toBe(true);
      }
    });

    it('lets the operator decide explicitly, either way', () => {
      configure({ allowPrivateOutboundTargets: true }, 'production');
      expect(privateOutboundTargetsAllowed()).toBe(true);
      configure({ allowPrivateOutboundTargets: false }, 'local');
      expect(privateOutboundTargetsAllowed()).toBe(false);
    });

    it('reads the string form NSC__SECURITY__ALLOW_PRIVATE_OUTBOUND_TARGETS produces', () => {
      configure({ allowPrivateOutboundTargets: 'false' }, 'local');
      expect(privateOutboundTargetsAllowed()).toBe(false);
      configure({ allowPrivateOutboundTargets: 'true' }, 'production');
      expect(privateOutboundTargetsAllowed()).toBe(true);
    });
  });

  describe('the URL check, before anything is sent', () => {
    it('refuses the metadata service, loopback by name and an IPv6 literal', async () => {
      configure({ allowPrivateOutboundTargets: false });
      await expect(assertOutboundUrlAllowed('http://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(
        OutboundUrlBlockedError,
      );
      await expect(assertOutboundUrlAllowed('http://localhost:3000/config')).rejects.toBeInstanceOf(
        OutboundUrlBlockedError,
      );
      await expect(assertOutboundUrlAllowed('http://[::1]:27017/')).rejects.toBeInstanceOf(OutboundUrlBlockedError);
    });

    it('refuses an IPv4 literal in a disguised notation', async () => {
      configure({ allowPrivateOutboundTargets: false });
      // The WHATWG parser normalises both to 127.0.0.1.
      await expect(assertOutboundUrlAllowed('http://2130706433/')).rejects.toBeInstanceOf(OutboundUrlBlockedError);
      await expect(assertOutboundUrlAllowed('http://0x7f.1/')).rejects.toBeInstanceOf(OutboundUrlBlockedError);
    });

    it('refuses a scheme other than http and https, even where internal targets are allowed', async () => {
      configure({ allowPrivateOutboundTargets: true });
      await expect(assertOutboundUrlAllowed('file:///etc/passwd')).rejects.toThrow(/http/);
      await expect(assertOutboundUrlAllowed('not a url')).rejects.toThrow(/Invalid/);
    });

    it('lets a public target through and returns the parsed URL', async () => {
      configure({ allowPrivateOutboundTargets: false });
      const parsed = await assertOutboundUrlAllowed('https://93.184.216.34/api');
      expect(parsed.hostname).toBe('93.184.216.34');
    });
  });

  describe('every connection, through the dispatcher', () => {
    let server: Server;
    let port: number;
    let redirector: Server;
    let redirectPort: number;

    beforeAll(async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as { port: number }).port;

      // Stands in for a public server that answers with a redirect into the internal network.
      redirector = createServer((_req, res) => {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/` });
        res.end();
      });
      await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
      redirectPort = (redirector.address() as { port: number }).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => redirector.close(() => resolve()));
    });

    it('refuses an internal host reached by name or literal', async () => {
      configure({ allowPrivateOutboundTargets: false });
      const dispatcher = createOutboundDispatcher();
      const { fetch } = await import('undici');
      for (const url of [`http://localhost:${port}/`, `http://127.0.0.1:${port}/`]) {
        await expect(fetch(url, { dispatcher })).rejects.toThrow();
      }
    });

    it('refuses the internal hop of a redirect, which the URL check never saw', async () => {
      // The first hop is explicitly allowed, the second is not: exactly the case a URL check alone
      // cannot cover.
      configure({ allowPrivateOutboundTargets: false });
      const dispatcher = createOutboundDispatcher({ allowedHosts: [`127.0.0.1:${redirectPort}`] });
      const { fetch } = await import('undici');
      await expect(fetch(`http://127.0.0.1:${redirectPort}/`, { dispatcher })).rejects.toThrow();
    });

    it('connects where internal targets are allowed', async () => {
      configure({ allowPrivateOutboundTargets: true });
      const response = await outboundFetch(`http://localhost:${port}/`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });

    it('lets an explicitly allowed internal host through, and only that one', async () => {
      configure({ allowPrivateOutboundTargets: false });
      const response = await outboundFetch(`http://127.0.0.1:${port}/`, undefined, {
        allowedHosts: [`127.0.0.1:${port}`],
      });
      expect(response.status).toBe(200);
      await expect(
        outboundFetch(`http://127.0.0.1:${port}/`, undefined, { allowedHosts: ['127.0.0.1:1'] }),
      ).rejects.toBeInstanceOf(OutboundUrlBlockedError);
    });

    it('outboundFetch refuses before sending, with the readable error', async () => {
      configure({ allowPrivateOutboundTargets: false });
      await expect(outboundFetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(OutboundUrlBlockedError);
    });
  });
});
