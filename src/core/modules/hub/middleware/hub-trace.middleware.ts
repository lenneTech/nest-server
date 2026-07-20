import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { HubTraceBufferService } from '../services/hub-trace-buffer.service';

/**
 * Measures request duration and records a trace at response completion.
 *
 * Registered by `CoreHubModule.configure()` ONLY when the traces collector is enabled (zero cost
 * otherwise — not even a no-op layer). Uses `hrtime` for timing and a latch so `finish` and `close`
 * (Express 5 / Node http.ServerResponse) never double-record; `close` without `writableFinished`
 * marks a client-aborted request.
 */
@Injectable()
export class HubTraceMiddleware implements NestMiddleware {
  constructor(private readonly traceBuffer: HubTraceBufferService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    // NestJS mounts `forRoutes('*')` middleware at a level where `req.path` is stripped to '/'; the
    // full request path lives in `req.originalUrl`. Use that for the exclusion check (and pass it to
    // the recorder as a fallback), otherwise the Hub's own routes are never excluded.
    const fullPath = (req.originalUrl || req.url || '').split('?')[0] || '/';
    if (!this.traceBuffer.enabled || this.traceBuffer.isExcluded(fullPath)) {
      next();
      return;
    }
    const start = process.hrtime.bigint();
    let recorded = false;
    const record = (aborted: boolean): void => {
      if (recorded) {
        return;
      }
      recorded = true;
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      try {
        this.traceBuffer.record(req, res, durationMs, aborted, fullPath);
      } catch {
        /* never let trace recording break the response path */
      }
    };
    res.on('finish', () => record(false));
    res.on('close', () => record(!res.writableFinished));
    next();
  }
}
