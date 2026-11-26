import { describe, expect, it } from 'vitest';

import { createBetterAuthInstance } from '../../src/core/modules/better-auth/better-auth.config';
import { CoreBetterAuthController } from '../../src/core/modules/better-auth/core-better-auth.controller';
import { CoreBetterAuthService } from '../../src/core/modules/better-auth/core-better-auth.service';

/**
 * `GET /iam/features` tells the auth client of `@lenne.tech/nuxt-extensions` whether to fetch a JWT (DEV-4361): from
 * 4.0.4 on it asks `<basePath>/token` only while the answer says `jwt: true`. The flag must therefore say exactly
 * whether the JWT plugin is registered — `true` with the plugin off sends every page load into a failed `/token`
 * request, `false` with the plugin on leaves a JWT-mode frontend without its token.
 */

/** Minimal MongoDB `Db` stand-in: lookups find nothing, writes succeed. */
const fakeDb: any = {
  collection: () => ({
    aggregate: () => ({ toArray: async () => [] }),
    createIndex: async () => undefined,
    find: () => {
      const cursor: any = { limit: () => cursor, skip: () => cursor, sort: () => cursor, toArray: async () => [] };
      return cursor;
    },
    findOne: async () => null,
    insertOne: async () => ({ insertedId: 'x' }),
  }),
};

const VALID_SECRET = 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing';
const API = 'https://api.example.com';
const APP = 'https://app.example.com';

function instanceFor(config: Record<string, unknown>): any {
  const result = createBetterAuthInstance({
    config: { enabled: true, secret: VALID_SECRET, ...config } as any,
    db: fakeDb,
    serverAppUrl: APP,
    serverBaseUrl: API,
    serverEnv: 'test',
  } as any);
  expect(result).not.toBeNull();
  return result!.instance;
}

async function jwtPluginRegistered(config: Record<string, unknown>): Promise<boolean> {
  const context = await instanceFor(config).$context;
  return context.options.plugins.some((plugin: { id: string }) => plugin.id === 'jwt');
}

/** What Better-Auth's own handler answers the client's token request with */
async function tokenRouteStatus(config: Record<string, unknown>): Promise<number> {
  const response: Response = await instanceFor(config).handler(
    new Request(`${API}/iam/token`, { headers: { origin: APP }, method: 'GET' }),
  );
  return response.status;
}

function featuresFor(config: Record<string, unknown>): Record<string, unknown> {
  const betterAuthService = new CoreBetterAuthService({ options: {} } as any, null as any, config as any);
  return CoreBetterAuthController.prototype.getFeatures.call({ betterAuthService } as any);
}

describe('GET /iam/features reports the JWT plugin as it is registered', () => {
  // The contract nuxt-extensions 4.0.4+ relies on: `jwt` follows the rule of buildPlugins(), so a project with
  // `jwt: false` gets no `/token` request on a page load
  it('says jwt: false, and the token route does not exist, when the plugin is switched off', async () => {
    for (const jwt of [false, { enabled: false }, { enabled: false, expiresIn: '1h' }]) {
      expect(featuresFor({ enabled: true, jwt }).jwt, JSON.stringify(jwt)).toBe(false);
      expect(await jwtPluginRegistered({ jwt }), JSON.stringify(jwt)).toBe(false);
    }
    expect(await tokenRouteStatus({ jwt: false })).toBe(404);
  });

  it('paired control: says jwt: true, and the token route exists, while the plugin is on (the default)', async () => {
    for (const jwt of [undefined, true, {}, { expiresIn: '1h' }, { enabled: true }]) {
      expect(featuresFor({ enabled: true, jwt }).jwt, JSON.stringify(jwt)).toBe(true);
      expect(await jwtPluginRegistered({ jwt }), JSON.stringify(jwt)).toBe(true);
    }
    // No session: Better-Auth refuses the request, but the route is there
    expect(await tokenRouteStatus({})).not.toBe(404);
  });

  it('says jwt: false while Better-Auth itself is off', () => {
    expect(featuresFor({ enabled: false }).jwt).toBe(false);
  });
});
