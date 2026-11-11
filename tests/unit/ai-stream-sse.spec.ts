/**
 * `POST /ai/stream` delivers every Server-Sent Event when it is produced, also behind `compression`.
 *
 * nest-server-starter and the reference `main.ts` register `compression`, and its default filter compresses
 * `text/event-stream`. gzip holds what is written until it has enough to compress or the response ends, so without a
 * way past it every event of a prompt run reached the client together at the end (measured: events written at 0, 300
 * and 600 ms all arrived at about 900 ms) — the stream behaved like a slow plain request. `/sync/hints` already kept
 * the compressor out with `Cache-Control: no-transform`; the AI stream did not.
 */
import compression from 'compression';
import express from 'express';
import type { Response } from 'express';
import type { Server } from 'http';
import { request as httpRequest } from 'http';
import type { AddressInfo } from 'net';
import { describe, expect, it } from 'vitest';

import { CoreAiController } from '../../src/core/modules/ai/core-ai.controller';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The real controller method, with an AI service that yields the given events `gapMs` apart */
function controllerYielding(events: unknown[], gapMs: number): CoreAiController {
  return Object.create(CoreAiController.prototype, {
    aiService: {
      value: {
        async *promptStream() {
          for (const [index, event] of events.entries()) {
            if (index > 0) {
              await sleep(gapMs);
            }
            yield event;
          }
        },
      },
    },
  }) as CoreAiController;
}

/** POSTs to the stream route with `Accept-Encoding: gzip` and records when each chunk arrived */
function receive(port: number): Promise<{ arrivals: number[]; encoding: string | undefined }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = httpRequest(
      {
        agent: false,
        headers: { 'accept-encoding': 'gzip', 'content-length': 2, 'content-type': 'application/json' },
        host: '127.0.0.1',
        method: 'POST',
        path: '/ai/stream',
        port,
        timeout: 5000,
      },
      (res) => {
        const arrivals: number[] = [];
        res.on('data', () => arrivals.push(Date.now() - started));
        res.on('end', () => resolve({ arrivals, encoding: res.headers['content-encoding'] }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('no complete answer within 5 s')));
    req.on('error', reject);
    req.end('{}');
  });
}

describe('POST /ai/stream behind compression', () => {
  /**
   * @regression   12.9.1 — behind `compression` (registered by nest-server-starter and the reference main.ts) gzip
   *   held every event of the AI stream until the run ended; a client saw nothing for the whole run and then
   *   everything at once.
   * @seen-failing Send `Cache-Control: no-cache` without `no-transform` in CoreAiController.stream()
   *   (src/core/modules/ai/core-ai.controller.ts) — registered as mutation `ai-stream-compressed` in
   *   tests/regression-mutations.json.
   */
  it('keeps the compressor out and delivers each event as it is produced', async () => {
    const controller = controllerYielding(
      [
        { text: 'a', type: 'token' },
        { text: 'b', type: 'token' },
        { type: 'final' },
      ],
      300,
    );
    const app = express();
    app.use(compression({ filter: compression.filter, threshold: 0 }));
    app.post('/ai/stream', (_req, res) => {
      void controller.stream({} as never, {} as never, res);
    });
    const server: Server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });

    try {
      const { arrivals, encoding } = await receive((server.address() as AddressInfo).port);

      expect(encoding).toBeUndefined();
      // The first event arrives right away, not when the run ends 600 ms later
      expect(arrivals.length).toBeGreaterThanOrEqual(3);
      expect(arrivals[0]).toBeLessThan(250);
      expect(arrivals.at(-1)! - arrivals[0]).toBeGreaterThan(400);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  /**
   * @regression   12.9.1 — a compressor that ignores `no-transform` (a project's own, or a proxy-side one in the same
   *   process) sends only what was flushed; without a flush per event the stream is held back the same way.
   * @seen-failing Write without flushing in CoreAiController.stream() (src/core/modules/ai/core-ai.controller.ts) —
   *   registered as mutation `ai-stream-never-flushes` in tests/regression-mutations.json.
   */
  it('flushes after every event, for a compressor that ignores no-transform', async () => {
    const calls: string[] = [];
    const res = {
      end: () => calls.push('end'),
      flush: () => calls.push('flush'),
      flushHeaders: () => undefined,
      setHeader: () => undefined,
      write: (chunk: string) => calls.push(`write ${chunk.startsWith('data:') ? 'event' : 'comment'}`),
    } as unknown as Response;

    await controllerYielding([{ type: 'token' }, { type: 'final' }], 0).stream({} as never, {} as never, res);

    expect(calls).toEqual(['write event', 'flush', 'write event', 'flush', 'end']);
  });
});
