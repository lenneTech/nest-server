import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { revalidateWsConnectionsOf } from '../../src/core/common/helpers/graphql-ws-connection.helper';
import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreSyncService } from '../../src/core/modules/sync/core-sync.service';

/**
 * `GET /sync/hints` ends its stream on every re-check: an HTTP stream has no handshake to repeat, so the EventSource
 * reconnects and the new request passes the guards. The planned end the re-check interval brings must not read like a
 * lost session in the log, while an end an invalidation brings (sign-out, role or tenant change) stays visible — under
 * the stream's own name. The mechanism is pinned in tests/unit/graphql-ws-connection.spec.ts; this case pins that
 * CoreSyncService registers its stream that way. `tests/sync-contract.e2e-spec.ts` (`hints-revalidation`) proves the
 * stream still ends on an invalidation over HTTP.
 */
describe('CoreSyncService.openHintStream — what an ended hint stream logs', () => {
  const USER = { id: 'user-sse', roles: [] };
  let previousConfig: Record<string, any>;
  let log: ReturnType<typeof vi.spyOn>;
  let debug: ReturnType<typeof vi.spyOn>;

  /** A request/response pair as Express hands it to the route, recording what the stream does with it. */
  const http = () => {
    const request = new EventEmitter() as EventEmitter & { destroyed?: boolean };
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
  const open = async () => {
    // The two collaborators the stream uses, set on an otherwise empty instance (both are protected)
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
    const { request, response } = http();
    await (service as CoreSyncService).openHintStream(request, response, USER);
    return { request, response, subscription };
  };

  const setRevalidationMs = (value: unknown) =>
    ConfigService.setConfig({ ...previousConfig, graphQl: { subscriptionRevalidationMs: value } } as any, {
      reInit: true,
      warn: false,
    });

  beforeAll(() => {
    previousConfig = { ...(ConfigService.configFastButReadOnly as any) };
  });

  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    log.mockRestore();
    debug.mockRestore();
  });

  afterAll(() => {
    ConfigService.setConfig(previousConfig as any, { reInit: true, warn: false });
  });

  /**
   * @regression   DEV-3920 — openHintStream() registered `reauthenticate: () => undefined`, so every planned end of a
   *   hint stream logged "Closing GraphQL WebSocket of user …: Session no longer valid" at `log`.
   * @seen-failing Register the stream with `reauthenticate: () => undefined` again in CoreSyncService.openHintStream()
   *   (src/core/modules/sync/core-sync.service.ts) — registered as mutation `sync-hint-stream-ends-as-lost-session` in
   *   tests/regression-mutations.json.
   */
  it('ends at the re-check interval before the hint, with a debug line and nothing at log', async () => {
    // 0: re-check before every hint, so the first hint after the open is past the interval
    setRevalidationMs(0);
    const { response, subscription } = await open();
    subscription.deliver?.({ at: Date.now(), model: 'SyncNote' });
    await vi.waitFor(() => expect(response.end).toHaveBeenCalled());
    expect(response.write.mock.calls.map(([chunk]) => chunk).join('')).not.toContain('event: change');
    expect(log).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      'Closing SSE hint stream of user user-sse: re-check interval reached, client reconnects',
    );
  });

  it('ends at once on an invalidation naming the subscriber, at log and under the stream name', async () => {
    setRevalidationMs(30_000);
    const { response } = await open();
    expect(revalidateWsConnectionsOf({ userId: 'user-sse' })).toBe(1);
    await vi.waitFor(() => expect(response.end).toHaveBeenCalled());
    expect(log).toHaveBeenCalledWith(
      'Closing SSE hint stream of user user-sse: authorization invalidated, client reconnects',
    );
  });

  it('delivers a hint inside the interval', async () => {
    setRevalidationMs(30_000);
    const { request, response, subscription } = await open();
    subscription.deliver?.({ at: Date.now(), model: 'SyncNote' });
    await vi.waitFor(() =>
      expect(response.write.mock.calls.map(([chunk]) => chunk).join('')).toContain('event: change'),
    );
    expect(response.end).not.toHaveBeenCalled();
    request.emit('close');
  });
});
