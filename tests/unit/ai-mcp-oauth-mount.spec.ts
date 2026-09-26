/**
 * Which URL does `mountAiMcpOAuth()` advertise?
 *
 * The OAuth issuer is not cosmetic: every endpoint in the discovery metadata is built from it,
 * and MCP clients follow those URLs verbatim. A deployed API that advertised
 * `http://localhost:3000` sent Claude Code off to register its client on the user's own
 * machine (`ECONNREFUSED`) — the server was fine, the metadata pointed elsewhere.
 *
 * These cases therefore assert on what a client actually receives — the served metadata —
 * rather than on the arguments handed to the SDK.
 *
 * Resolution under test (the same one BetterAuth and CORS use, via `resolveServerUrls`):
 *   explicit `options.baseUrl` → `config.baseUrl` → localhost default in `local`/`ci`/`e2e` only
 *   → otherwise refuse to boot rather than guess.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';
import { mountAiMcpOAuth } from '../../src/core/modules/ai/helpers/ai-mcp-oauth.helper';
import { CoreAiMcpOAuthService } from '../../src/core/modules/ai/services/core-ai-mcp-oauth.service';

/** Replaces (not merges) the static config, so no case inherits another case's `baseUrl`. */
function useServerConfig(config: { baseUrl?: string; env?: string }): void {
  ConfigService.setConfig(
    { ai: { mcp: { oauth: true, oauthSecret: 'unit-mcp-oauth-mount-secret-32chars!' } }, ...config } as any,
    { reInit: true, warn: false },
  );
}

/** Mounts the helper on a real express app and returns what a discovering MCP client would read. */
async function mountAndDiscover(options?: Parameters<typeof mountAiMcpOAuth>[1]) {
  const oauthService = new CoreAiMcpOAuthService({} as any);
  const server = express();
  await mountAiMcpOAuth({ get: () => oauthService, use: (...args: any[]) => server.use(...args) }, options);

  // Fails with the status and body rather than letting a later `.issuer` read `undefined`,
  // which says nothing about why.
  const discover = async (path: string) => {
    const response = await request(server).get(path);
    if (response.status !== 200) {
      throw new Error(`GET ${path} answered ${response.status}: ${response.text}`);
    }
    return response.body;
  };
  return {
    authorizationServer: await discover('/.well-known/oauth-authorization-server'),
    protectedResource: await discover(`/.well-known/oauth-protected-resource${options?.mcpPath ?? '/ai/mcp'}`),
  };
}

describe('mountAiMcpOAuth — advertised issuer', () => {
  it('advertises config.baseUrl when no baseUrl is passed', async () => {
    useServerConfig({ baseUrl: 'https://api.example.com', env: 'production' });

    const { authorizationServer, protectedResource } = await mountAndDiscover();

    expect(authorizationServer.issuer).toBe('https://api.example.com/');
    expect(authorizationServer.token_endpoint).toBe('https://api.example.com/token');
    expect(authorizationServer.registration_endpoint).toBe('https://api.example.com/register');
    expect(protectedResource.resource).toBe('https://api.example.com/ai/mcp');
    expect(protectedResource.authorization_servers).toEqual(['https://api.example.com/']);
  });

  it('lets an explicit baseUrl win over config.baseUrl', async () => {
    useServerConfig({ baseUrl: 'https://api.example.com', env: 'production' });

    const { authorizationServer, protectedResource } = await mountAndDiscover({ baseUrl: 'https://mcp.example.org' });

    expect(authorizationServer.issuer).toBe('https://mcp.example.org/');
    expect(protectedResource.resource).toBe('https://mcp.example.org/ai/mcp');
  });

  it.each(['', '   '])('treats a blank baseUrl (%j, e.g. `BASE_URL=` in an env file) as not given', async (blank) => {
    useServerConfig({ baseUrl: 'https://api.example.com', env: 'production' });

    const { authorizationServer } = await mountAndDiscover({ baseUrl: blank });

    expect(authorizationServer.issuer).toBe('https://api.example.com/');
  });

  it('keeps a custom mcpPath and does not double a trailing slash on the base URL', async () => {
    useServerConfig({ baseUrl: 'https://api.example.com/', env: 'production' });

    const { protectedResource } = await mountAndDiscover({ mcpPath: '/tools/mcp' });

    expect(protectedResource.resource).toBe('https://api.example.com/tools/mcp');
  });

  it.each(['local', 'ci', 'e2e'])('falls back to the localhost default in %s, like BetterAuth does', async (env) => {
    useServerConfig({ env });

    const { authorizationServer } = await mountAndDiscover();

    expect(authorizationServer.issuer).toBe('http://localhost:3000/');
  });

  it.each(['production', 'staging', 'develop', undefined])(
    'refuses to guess a URL in env %s when none is configured',
    async (env) => {
      useServerConfig({ env });

      await expect(mountAndDiscover()).rejects.toThrow(/NSC__BASE_URL/);
    },
  );

  it('names the URL and where it came from when the SDK rejects it', async () => {
    useServerConfig({ baseUrl: 'http://api.example.com', env: 'production' });

    const attempt = mountAndDiscover();

    await expect(attempt).rejects.toThrow(/http:\/\/api\.example\.com/);
    await expect(attempt).rejects.toThrow(/config\.baseUrl/);
    await expect(attempt).rejects.toThrow(/HTTPS/);
  });

  it('rejects an explicit value that is not an absolute URL, naming it', async () => {
    useServerConfig({ baseUrl: 'https://api.example.com', env: 'production' });

    // `/` is what Vite/Vitest inject into process.env.BASE_URL — a plausible accident.
    const attempt = mountAndDiscover({ baseUrl: '/' });

    await expect(attempt).rejects.toThrow(/"\/"/);
    await expect(attempt).rejects.toThrow(/options\.baseUrl/);
  });
});
