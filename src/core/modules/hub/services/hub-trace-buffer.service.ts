import { Inject, Injectable } from '@nestjs/common';
import { Request, Response } from 'express';

import { HUB_CONFIG } from '../hub.constants';
import { HubRingBuffer } from '../hub-ring-buffer';
import { HubTraceRecord, HubTracesData } from '../interfaces/hub-panels.interface';
import { ResolvedHubConfig } from '../interfaces/hub-config.interface';

interface TraceRecord extends HubTraceRecord {
  timestamp: number;
}

/**
 * Ring buffer for HTTP request traces, fed by {@link HubTraceMiddleware}.
 *
 * Structurally incapable of leaking secrets: it stores only method, route pattern (never the query
 * string), status, duration, an optional GraphQL operation name and the user id — no headers,
 * cookies, bodies or GraphQL variables.
 */
@Injectable()
export class HubTraceBufferService {
  private readonly buffer?: HubRingBuffer<TraceRecord>;
  private readonly cfg?: Exclude<ResolvedHubConfig['collectors']['traces'], false>;
  private readonly excludePrefixes: string[];

  constructor(@Inject(HUB_CONFIG) protected readonly config: ResolvedHubConfig) {
    if (config.collectors.traces !== false) {
      this.cfg = config.collectors.traces;
      this.buffer = new HubRingBuffer<TraceRecord>(this.cfg.capacity);
    }
    // Always exclude the Hub's own routes so polling does not flood the trace list with self-noise.
    this.excludePrefixes = [...(this.cfg?.excludePaths ?? []), '/' + config.path];
  }

  clear(): void {
    this.buffer?.clear();
  }

  get enabled(): boolean {
    return this.config.collectors.traces !== false;
  }

  getData(since?: number): HubTracesData {
    const records = !this.buffer ? [] : since === undefined ? this.buffer.recent() : this.buffer.since(since);
    let totalMs = 0;
    let slowCount = 0;
    let errorCount = 0;
    for (const r of records) {
      totalMs += r.durationMs;
      if (r.slow) {
        slowCount++;
      }
      if (r.error) {
        errorCount++;
      }
    }
    return {
      cursor: this.buffer?.lastSeq ?? -1,
      dropped: this.buffer?.firstRetainedSeq ?? -1,
      summary: { avgMs: records.length ? totalMs / records.length : 0, errorCount, slowCount, total: records.length },
      traces: records,
    };
  }

  /** True when the path is excluded (Hub routes, configured prefixes). */
  isExcluded(path: string): boolean {
    // Boundary-aware: a prefix of `/hub` excludes `/hub` and `/hub/...` but NOT `/hubble` — a bare
    // `startsWith(prefix)` would wrongly drop sibling routes that merely share the prefix string.
    return this.excludePrefixes.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
  }

  /** Record a completed request. Called from the middleware at `finish`/`close`. */
  record(req: Request, res: Response, durationMs: number, aborted: boolean, fullPath?: string): void {
    if (!this.buffer || !this.cfg) {
      return;
    }
    const statusCode = res.statusCode;
    const contentLength = Number(res.getHeader('content-length')) || undefined;
    this.buffer.add({
      aborted: aborted || undefined,
      contentLength,
      durationMs,
      error: statusCode >= 500 || undefined,
      graphqlOperation: this.cfg.captureGraphQlOperation ? this.graphqlOperation(req) : undefined,
      method: req.method,
      path: this.routePattern(req, fullPath),
      slow: durationMs > this.cfg.slowMs || undefined,
      statusCode,
      userId: (req as unknown as { user?: { id?: string } }).user?.id,
    } as Omit<TraceRecord, 'seq' | 'timestamp'>);
  }

  /** Collapse high-cardinality ids so the buffer does not explode on 404s / unmatched routes. */
  private collapseParams(path: string): string {
    return path
      .replace(/\/[a-f0-9]{24}(?=\/|$)/gi, '/:id')
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:id')
      .replace(/\/\d+(?=\/|$)/g, '/:n');
  }

  private graphqlOperation(req: Request): string | undefined {
    if (req.method !== 'POST' || !req.path.endsWith('/graphql')) {
      return undefined;
    }
    const body = (req as unknown as { body?: unknown }).body;
    if (Array.isArray(body)) {
      return `batch(${body.length})`;
    }
    const op = (body as { operationName?: string; query?: string })?.operationName;
    if (op) {
      return op;
    }
    const query = (body as { query?: string })?.query;
    if (typeof query === 'string') {
      const match = /\b(query|mutation|subscription)\s+([A-Za-z_]\w*)/.exec(query.slice(0, 500));
      if (match) {
        return match[2];
      }
    }
    return 'anonymous';
  }

  /** Route pattern when the router resolved one, else a param-collapsed raw path (never the query string). */
  private routePattern(req: Request, fullPath?: string): string {
    const route = (req as unknown as { route?: { path?: string } }).route?.path;
    const base = req.baseUrl || '';
    if (route && base) {
      return base + (route === '/' ? '' : route) || '/';
    }
    // Fallback: the mount-stripped `req.path` is unreliable under `forRoutes('*')`; prefer the full
    // path captured by the middleware, with high-cardinality ids collapsed.
    return this.collapseParams(fullPath || req.baseUrl || req.path);
  }
}
