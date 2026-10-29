import { describe, expect, it } from 'vitest';

import { CoreAiMcpOAuthService } from '../../src/core/modules/ai/services/core-ai-mcp-oauth.service';
import { createMcpOAuthMemoryConnection } from '../helpers/mcp-oauth-memory-connection';

const MINUTE = 60_000;

/** A service and its codes collection, with one code saved `ageMinutes` ago — as if nobody had swept it */
async function codeAged(ageMinutes: number) {
  const connection = createMcpOAuthMemoryConnection();
  const service = new CoreAiMcpOAuthService(connection as any);
  await service.saveAuthorizationCode('code-1', { clientId: 'client-1', codeChallenge: 'challenge', userId: 'user-1' });
  const codes = connection.db.collection('aiMcpOAuthCodes');
  codes.docs[0].createdAt = new Date(Date.now() - ageMinutes * MINUTE);
  return { codes, service };
}

/**
 * An authorization code lives ten minutes. Until DEV-3832 nothing but MongoDB's TTL index enforced that: the monitor
 * deletes late (about once a minute, under load later), the index was created lazily on the first write, and a failed
 * creation was never retried — so an expired code was exchanged for an access and a refresh token for as long as it
 * stayed in the collection. The age is now checked on every read, whatever the database and whether or not anything
 * swept the code.
 *
 * @regression   DEV-3832 (db-agnostic phase 4) — getAuthorizationCode() and consumeAuthorizationCode() accepted a code
 *   of any age; only the TTL index removed it, eventually.
 * @seen-failing Drop the age check in CoreAiMcpOAuthService.liveCode() in
 *   src/core/modules/ai/services/core-ai-mcp-oauth.service.ts — registered as mutation `mcp-oauth-code-age-unchecked`
 *   in tests/regression-mutations.json.
 */
describe('MCP OAuth authorization code expiry', () => {
  it('refuses a code older than ten minutes, before any sweep removed it', async () => {
    const { codes, service } = await codeAged(11);

    expect(await service.getAuthorizationCode('code-1')).toBeNull();
    expect(await service.consumeAuthorizationCode('code-1', 'client-1')).toBeNull();
    // Consuming an expired code removes it: it can never be presented again
    expect(codes.docs).toHaveLength(0);
  });

  it('accepts a code inside its ten minutes, once', async () => {
    const { service } = await codeAged(9);

    expect(await service.getAuthorizationCode('code-1')).toMatchObject({ clientId: 'client-1', userId: 'user-1' });
    expect(await service.consumeAuthorizationCode('code-1', 'client-1')).toMatchObject({ userId: 'user-1' });
    expect(await service.consumeAuthorizationCode('code-1', 'client-1')).toBeNull();
  });
});
