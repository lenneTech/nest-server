import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { revalidateWsConnectionsOf } from '../../src/core/common/helpers/graphql-ws-connection.helper';
import { ConfigService } from '../../src/core/common/services/config.service';
import {
  getTenantContextResolver,
  setTenantContextResolver,
} from '../../src/core/common/services/core-tenant-context.registry';
import { RequestContext } from '../../src/core/common/services/request-context.service';
import {
  getBetterAuthTokenService,
  setBetterAuthTokenService,
} from '../../src/core/modules/better-auth/core-better-auth.registry';
import { CoreSyncService } from '../../src/core/modules/sync/core-sync.service';

/**
 * `GET /sync/hints` re-checked IN PLACE (12.11.0): a stream opened with a Better-Auth credential stays open while the
 * subscriber's rights are unchanged, so a hint after the re-check interval or after an invalidation reaches the client
 * without a reconnect, and the stream is closed only when the rights changed. A stream whose credential cannot be
 * re-run keeps ending on every re-check — tests/unit/sync-hint-stream-log.spec.ts pins that and its log lines. The
 * mechanism is pinned in tests/unit/http-stream-recheck.spec.ts.
 */
describe('CoreSyncService.openHintStream — re-checked in place', () => {
  const USER = { email: 'sse@example.com', id: 'user-sse', roles: ['editor'], verified: true };
  const SESSION_TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
  let previousConfig: Record<string, any>;
  let previousResolver: ReturnType<typeof getTenantContextResolver>;
  let previousTokenService: ReturnType<typeof getBetterAuthTokenService>;
  let log: ReturnType<typeof vi.spyOn>;
  /** What the token service answers for the stream's credential — a case changes it */
  let current: { user: any };
  let verifyAndLoadUser: ReturnType<typeof vi.fn>;

  /** A request/response pair as Express hands it to the route, recording what the stream does with it. */
  const http = (headers: Record<string, string>) => {
    const request = Object.assign(new EventEmitter(), { headers }) as EventEmitter & { destroyed?: boolean };
    const response = Object.assign(new EventEmitter(), {
      end: vi.fn(),
      flush: vi.fn(),
      flushHeaders: vi.fn(),
      setHeader: vi.fn(),
      status: vi.fn(),
      write: vi.fn(),
    });
    return { request, response };
  };

  /** Open a stream on a service whose filter admits every hint, and hand back the hint subscriber. */
  const open = async (
    headers: Record<string, string> = { authorization: `Bearer ${SESSION_TOKEN}` },
    context?: Record<string, unknown>,
  ) => {
    const service: any = Object.create(CoreSyncService.prototype);
    const subscription: { deliver?: (hint: any) => void } = {};
    service.hintFilter = async () => () => true;
    service.hintService = {
      subscribe: (deliver: (hint: any) => void) => {
        subscription.deliver = deliver;
        return () => {
          subscription.deliver = undefined;
        };
      },
    };
    const { request, response } = http(headers);
    const openStream = () => (service as CoreSyncService).openHintStream(request, response, USER);
    await (context ? RequestContext.run(context, openStream) : openStream());
    const written = () => response.write.mock.calls.map(([chunk]) => chunk).join('');
    return { request, response, subscription, written };
  };

  const setRevalidationMs = (value: unknown) =>
    ConfigService.setConfig({ ...previousConfig, graphQl: { subscriptionRevalidationMs: value } } as any, {
      reInit: true,
      warn: false,
    });

  beforeAll(() => {
    previousConfig = { ...(ConfigService.configFastButReadOnly as any) };
    previousResolver = getTenantContextResolver();
    previousTokenService = getBetterAuthTokenService();
  });

  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    current = { user: USER };
    verifyAndLoadUser = vi.fn(async (token: string) => (token === SESSION_TOKEN ? current.user : null));
    setBetterAuthTokenService({ verifyAndLoadUser } as any);
    setTenantContextResolver(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    ConfigService.setConfig(previousConfig as any, { reInit: true, warn: false });
    setTenantContextResolver(previousResolver);
    setBetterAuthTokenService(previousTokenService);
  });

  it('delivers a hint after the re-check interval without ending the stream while the rights are unchanged', async () => {
    // 0: re-check before every hint, so each hint is past the interval
    setRevalidationMs(0);
    const { request, response, subscription, written } = await open();
    subscription.deliver?.({ at: Date.now(), model: 'SyncNote' });
    subscription.deliver?.({ at: Date.now(), model: 'SyncTask' });
    await vi.waitFor(() => expect(written()).toContain('"model":"SyncTask"'));
    expect(written()).toContain('"model":"SyncNote"');
    expect(response.end).not.toHaveBeenCalled();
    // Once when the stream opened, then once per re-check: the credential is run again, not trusted
    expect(verifyAndLoadUser.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(verifyAndLoadUser).toHaveBeenCalledWith(SESSION_TOKEN);
    request.emit('close');
  });

  it('stays open on an invalidation that changed nothing and delivers the next hint', async () => {
    setRevalidationMs(30_000);
    const { request, response, subscription, written } = await open();
    expect(revalidateWsConnectionsOf({ userId: 'user-sse' })).toBe(1);
    await vi.waitFor(() => expect(verifyAndLoadUser).toHaveBeenCalledTimes(2));
    subscription.deliver?.({ at: Date.now(), model: 'SyncNote' });
    await vi.waitFor(() => expect(written()).toContain('event: change'));
    expect(response.end).not.toHaveBeenCalled();
    request.emit('close');
  });

  /**
   * The paired refusal: kept open, the stream must still close the moment the subscriber's rights changed — before a
   * hint computed for the old rights goes out.
   */
  it('ends without delivering the hint once the roles changed or the session is gone', async () => {
    setRevalidationMs(0);
    for (const changed of [{ ...USER, roles: [] }, null]) {
      current.user = USER;
      const { response, subscription, written } = await open();
      current.user = changed;
      subscription.deliver?.({ at: Date.now(), model: 'SyncNote' });
      await vi.waitFor(() => expect(response.end).toHaveBeenCalled());
      expect(written()).not.toContain('event: change');
    }
    expect(log).toHaveBeenCalledWith('Closing SSE hint stream of user user-sse: User authorization changed');
    expect(log).toHaveBeenCalledWith('Closing SSE hint stream of user user-sse: Session no longer valid');
  });

  it('re-validates the tenant header and ends once the membership is gone', async () => {
    setRevalidationMs(30_000);
    const memberships = new Set(['tenant-a']);
    const resolve = vi.fn(async (_user: any, header?: string) =>
      header && memberships.has(header) ? { tenantId: header, tenantRole: 'member' } : {},
    );
    setTenantContextResolver({ resolve });
    const { response, subscription, written } = await open(
      { authorization: `Bearer ${SESSION_TOKEN}`, 'x-tenant-id': 'tenant-a' },
      { tenantId: 'tenant-a', tenantRole: 'member' },
    );
    expect(resolve).toHaveBeenCalledWith(USER, 'tenant-a');
    expect(response.end).not.toHaveBeenCalled();

    memberships.delete('tenant-a');
    revalidateWsConnectionsOf({ userId: 'user-sse' });
    await vi.waitFor(() => expect(response.end).toHaveBeenCalled());
    subscription.deliver?.({ at: Date.now(), model: 'SyncTask' });
    expect(written()).not.toContain('event: change');
    expect(log).toHaveBeenCalledWith('Closing SSE hint stream of user user-sse: Tenant access changed');
  });

  it('keeps ending on every re-check when its credential cannot be re-run', async () => {
    setRevalidationMs(0);
    const { response, subscription, written } = await open({ authorization: 'Bearer unknown-session-token' });
    subscription.deliver?.({ at: Date.now(), model: 'SyncNote' });
    await vi.waitFor(() => expect(response.end).toHaveBeenCalled());
    expect(written()).not.toContain('event: change');
    expect(log).not.toHaveBeenCalled();
  });

  it('can be switched off by a project: recheckHintStreamInPlace() answering false', async () => {
    setRevalidationMs(0);
    const recheck = vi.spyOn(CoreSyncService.prototype as any, 'recheckHintStreamInPlace').mockResolvedValue(false);
    const { response, subscription } = await open();
    expect(recheck).toHaveBeenCalledTimes(1);
    subscription.deliver?.({ at: Date.now(), model: 'SyncNote' });
    await vi.waitFor(() => expect(response.end).toHaveBeenCalled());
    expect(verifyAndLoadUser).not.toHaveBeenCalled();
  });
});
