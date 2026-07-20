import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { redactSensitiveText } from '../../../common/helpers/logging.helper';
import { HUB_CONFIG, HUB_QUERY_PENDING_LIMIT } from '../hub.constants';
import { HubRingBuffer } from '../hub-ring-buffer';
import { normalizeCommandShape } from '../helpers/hub-command-shape.helper';
import { HubQueriesData, HubQueryRecord, HubQueryTemplate } from '../interfaces/hub-panels.interface';
import { ResolvedHubConfig } from '../interfaces/hub-config.interface';

interface ProfilerRecord extends HubQueryRecord {
  timestamp: number;
}

interface PendingCommand {
  collection: string;
  operation: string;
  shape: string;
}

/**
 * Admin/heartbeat/metadata commands that are pure noise for a query profiler.
 *
 * `dbstats` / `listcollections` / `listindexes` are metadata reads (issued, among others, by the
 * Hub's own DB panel) and are never app-level queries worth profiling. `aggregate` and `find` are
 * deliberately NOT ignored — they carry real query shapes — so the Hub's own `$collStats`/`find`
 * self-noise on the DB/Files panels is inherent and cannot be filtered by command name alone.
 */
const DEFAULT_IGNORE = new Set([
  'authenticate',
  'buildinfo',
  'connectionstatus',
  'dbstats',
  'getnonce',
  'getparameter',
  'hello',
  'ismaster',
  'listcollections',
  'listindexes',
  'logout',
  'ping',
  'saslcontinue',
  'saslstart',
]);

/** Only these command names carry a query shape worth normalizing. */
const SHAPED_FIELDS = ['filter', 'query', 'pipeline', 'sort', 'projection', 'q', 'u', 'updates', 'deletes'];

/**
 * MongoDB query profiler backed by driver command monitoring.
 *
 * Requires the connection to be created with `monitorCommands: true` (opted in from core.module.ts
 * only when this collector is enabled). Records command SHAPES (values → '?') — never values — which
 * doubles as the N+1 template key. Zero cost when disabled: no `getClient`, no listeners.
 */
@Injectable()
export class HubQueryProfilerService implements OnModuleDestroy, OnModuleInit {
  protected readonly logger = new Logger(HubQueryProfilerService.name);

  private buffer?: HubRingBuffer<ProfilerRecord>;
  private client?: {
    off?: (e: string, l: (...a: any[]) => void) => void;
    on: (e: string, l: (...a: any[]) => void) => void;
    options?: { monitorCommands?: boolean };
    removeListener?: (e: string, l: (...a: any[]) => void) => void;
  };
  private cfg?: Exclude<ResolvedHubConfig['collectors']['queries'], false>;
  private ignore = DEFAULT_IGNORE;
  // Hot-path driver-event handlers. Each is fully guarded: an exception here runs inside the MongoDB
  // driver's synchronous `emit()`, so it would surface as an UNCAUGHT exception and take the whole
  // process down. Observability must never crash the app — swallow everything.
  private readonly onFailed = (e: any): void => this.safe(() => this.handleFinished(e, e?.failure?.message));
  private readonly onStarted = (e: any): void => this.safe(() => this.handleStarted(e));
  private readonly onSucceeded = (e: any): void => this.safe(() => this.handleFinished(e, undefined));
  private readonly pending = new Map<number, PendingCommand>();

  constructor(
    @Inject(HUB_CONFIG) protected readonly config: ResolvedHubConfig,
    @Optional() @InjectConnection() protected readonly connection?: Connection,
  ) {}

  /** Clear the buffer (Hub action). */
  clear(): void {
    this.buffer?.clear();
    this.pending.clear();
  }

  get enabled(): boolean {
    return this.config.collectors.queries !== false;
  }

  getData(): HubQueriesData {
    const records = this.buffer?.recent() ?? [];
    return {
      cursor: this.buffer?.lastSeq ?? -1,
      recent: records.slice(-100),
      slowest: [...records].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
      summary: this.summary(records),
      topTemplates: this.topTemplates(records),
    };
  }

  onModuleDestroy(): void {
    if (!this.client) {
      return;
    }
    const off = this.client.removeListener ?? this.client.off;
    off?.call(this.client, 'commandStarted', this.onStarted);
    off?.call(this.client, 'commandSucceeded', this.onSucceeded);
    off?.call(this.client, 'commandFailed', this.onFailed);
    this.pending.clear();
    this.client = undefined;
  }

  onModuleInit(): void {
    if (this.config.collectors.queries === false) {
      return; // zero cost when disabled
    }
    this.cfg = this.config.collectors.queries;
    this.buffer = new HubRingBuffer<ProfilerRecord>(this.cfg.capacity);
    if (this.cfg.ignoreCommands?.length) {
      this.ignore = new Set(this.cfg.ignoreCommands.map((c) => c.toLowerCase()));
    }
    const client = this.connection?.getClient?.() as unknown as HubQueryProfilerService['client'];
    if (!client) {
      return;
    }
    if (client.options?.monitorCommands !== true) {
      this.logger.warn(
        'hub.collectors.queries is enabled but the MongoDB driver was not started with monitorCommands — query profiling is inactive.',
      );
      return;
    }
    this.client = client;
    client.on('commandStarted', this.onStarted);
    client.on('commandSucceeded', this.onSucceeded);
    client.on('commandFailed', this.onFailed);
  }

  /** Run a hot-path handler, swallowing any error so it can never escape into the driver's emit(). */
  protected safe(fn: () => void): void {
    try {
      fn();
    } catch {
      /* observability must never crash the app */
    }
  }

  protected classify(durationMs: number): HubQueryRecord['classification'] {
    if (!this.cfg) {
      return 'ok';
    }
    if (durationMs > this.cfg.criticalMs) {
      return 'critical';
    }
    if (durationMs > this.cfg.warnMs) {
      return 'warn';
    }
    return 'ok';
  }

  protected handleFinished(event: { duration?: number; requestId?: number }, errorMessage?: string): void {
    const requestId = event?.requestId;
    if (requestId === undefined) {
      return;
    }
    const pending = this.pending.get(requestId);
    this.pending.delete(requestId);
    if (!pending || !this.buffer) {
      return;
    }
    const durationMs = Number(event.duration ?? 0);
    this.buffer.add({
      classification: this.classify(durationMs),
      collection: pending.collection,
      commandSummary: pending.shape,
      durationMs,
      errorMessage: errorMessage ? redactSensitiveText(String(errorMessage)).slice(0, 300) : undefined,
      failed: !!errorMessage,
      operation: pending.operation,
      requestId,
    } as Omit<ProfilerRecord, 'seq' | 'timestamp'>);
  }

  protected handleStarted(event: {
    command?: Record<string, unknown>;
    commandName?: string;
    requestId?: number;
  }): void {
    const operation = String(event?.commandName ?? '').toLowerCase();
    if (!operation || this.ignore.has(operation) || event.requestId === undefined) {
      return;
    }
    const command = event.command ?? {};
    const collection = this.extractCollection(command, operation);
    const shape = this.buildShape(operation, collection, command);

    // Bound the pending map even if succeeded/failed events are lost (connection drop).
    if (this.pending.size >= HUB_QUERY_PENDING_LIMIT) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) {
        this.pending.delete(oldest);
      }
    }
    this.pending.set(event.requestId, { collection, operation, shape });
  }

  private buildShape(operation: string, collection: string, command: Record<string, unknown>): string {
    const sections: Record<string, unknown> = {};
    for (const field of SHAPED_FIELDS) {
      if (command[field] !== undefined) {
        sections[field] = normalizeCommandShape(command[field]);
      }
    }
    if (Array.isArray(command.documents)) {
      sections.documents = `documents(${command.documents.length})`;
    }
    const maxLen = this.cfg?.maxShapeLength ?? 512;
    return `${operation} ${collection} ${JSON.stringify(sections)}`.slice(0, maxLen);
  }

  private extractCollection(command: Record<string, unknown>, operation: string): string {
    const byName = command[operation] ?? command[Object.keys(command)[0]];
    if (typeof byName === 'string') {
      return byName;
    }
    if (typeof command.collection === 'string') {
      return command.collection;
    }
    return '(unknown)';
  }

  private summary(records: ProfilerRecord[]): HubQueriesData['summary'] {
    let total = 0;
    let warnCount = 0;
    let criticalCount = 0;
    let failedCount = 0;
    for (const r of records) {
      total += r.durationMs;
      if (r.classification === 'warn') {
        warnCount++;
      }
      if (r.classification === 'critical') {
        criticalCount++;
      }
      if (r.failed) {
        failedCount++;
      }
    }
    return {
      avgMs: records.length ? total / records.length : 0,
      criticalCount,
      failedCount,
      total: records.length,
      warnCount,
    };
  }

  private topTemplates(records: ProfilerRecord[]): HubQueryTemplate[] {
    const map = new Map<string, { count: number; max: number; total: number }>();
    for (const r of records) {
      const entry = map.get(r.commandSummary) ?? { count: 0, max: 0, total: 0 };
      entry.count++;
      entry.total += r.durationMs;
      entry.max = Math.max(entry.max, r.durationMs);
      map.set(r.commandSummary, entry);
    }
    return [...map.entries()]
      .map(([template, e]) => ({ avgMs: e.total / e.count, count: e.count, maxMs: e.max, template }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }
}
