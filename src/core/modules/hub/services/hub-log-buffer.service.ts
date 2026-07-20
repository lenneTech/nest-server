import {
  ConsoleLogger,
  Inject,
  Injectable,
  Logger,
  LoggerService,
  LogLevel,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { inspect } from 'util';

import { redactSensitiveText } from '../../../common/helpers/logging.helper';
import { HUB_CONFIG } from '../hub.constants';
import { HubRingBuffer } from '../hub-ring-buffer';
import { HubLogRecord, HubLogsData } from '../interfaces/hub-panels.interface';
import { ResolvedHubConfig } from '../interfaces/hub-config.interface';

interface BufferedLog extends HubLogRecord {
  timestamp: number;
}

/**
 * A LoggerService that CHAINS to whatever logger was active before it, so nothing is swallowed, and
 * feeds each record into the Hub's ring buffer. Installed process-globally via `Logger.overrideLogger`.
 */
class HubDelegatingLogger implements LoggerService {
  detached = false;

  constructor(
    private readonly capture: (level: LogLevel, message: unknown, params: unknown[]) => void,
    private readonly previous: LoggerService | undefined,
    private readonly fallback: ConsoleLogger,
  ) {}

  debug(message: unknown, ...params: unknown[]): void {
    this.handle('debug', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.handle('error', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.handle('fatal', message, params);
  }

  log(message: unknown, ...params: unknown[]): void {
    this.handle('log', message, params);
  }

  setLogLevels(levels: LogLevel[]): void {
    this.fallback.setLogLevels?.(levels);
    (this.previous as { setLogLevels?: (l: LogLevel[]) => void } | undefined)?.setLogLevels?.(levels);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.handle('verbose', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.handle('warn', message, params);
  }

  private handle(level: LogLevel, message: unknown, params: unknown[]): void {
    if (!this.detached) {
      try {
        this.capture(level, message, params);
      } catch {
        /* the capture path must NEVER throw into the caller's log statement */
      }
    }
    const target = this.previous ?? this.fallback;
    try {
      (target as unknown as Record<string, (...a: unknown[]) => void>)[level]?.(message, ...params);
    } catch {
      /* chaining must not break either */
    }
  }
}

/**
 * Captures NestJS `Logger` output into a ring buffer for the Logs panel — WITHOUT requiring the
 * consumer to touch main.ts.
 *
 * `Logger.overrideLogger()` installs a delegating logger process-globally (the same mechanism
 * `app.useLogger()` uses internally). It chains to the pre-existing logger (never swallows), applies
 * secret redaction + truncation, and restores the previous logger on shutdown — owner-checked, so a
 * newer override is never clobbered (the multi-app test-safety concern). Zero cost when disabled.
 */
@Injectable()
export class HubLogBufferService implements OnModuleDestroy, OnModuleInit {
  private buffer?: HubRingBuffer<BufferedLog>;
  private cfg?: Exclude<ResolvedHubConfig['collectors']['logs'], false>;
  private delegating?: HubDelegatingLogger;
  private excludeContexts = new Set<string>();
  private previousRef?: LoggerService;

  constructor(@Inject(HUB_CONFIG) protected readonly config: ResolvedHubConfig) {}

  /** Idempotent install of the delegating logger. Public so reads can self-heal after a foreign override. */
  attach(): void {
    if (this.config.collectors.logs === false) {
      return;
    }
    if (!this.cfg) {
      this.cfg = this.config.collectors.logs;
      this.buffer = new HubRingBuffer<BufferedLog>(this.cfg.capacity);
      this.excludeContexts = new Set(this.cfg.excludeContexts);
    }
    const current = this.staticRef();
    if (current === this.delegating) {
      return; // still the owner
    }
    // Never chain onto another (foreign/stale) HubDelegatingLogger — that would accumulate a growing
    // delegate chain across app instances in the same process (parallel tests). Fall back to the
    // ConsoleLogger instead; a real, non-Hub logger is chained to as the previous target.
    const previous = current instanceof HubDelegatingLogger ? undefined : current;
    const fallback = new ConsoleLogger();
    const levels = (Logger as unknown as { logLevels?: LogLevel[] }).logLevels;
    if (levels) {
      fallback.setLogLevels(levels);
    }
    this.previousRef = previous;
    this.delegating = new HubDelegatingLogger(
      (level, message, params) => this.push(level, message, params),
      previous,
      fallback,
    );
    Logger.overrideLogger(this.delegating);
  }

  clear(): void {
    this.buffer?.clear();
  }

  detach(): void {
    if (this.delegating) {
      this.delegating.detached = true;
    }
    // Only restore if we are still the owner — never clobber a newer override.
    if (this.delegating && this.staticRef() === this.delegating) {
      Logger.overrideLogger(this.previousRef ?? (undefined as unknown as LoggerService));
    }
    this.delegating = undefined;
  }

  get enabled(): boolean {
    return this.config.collectors.logs !== false;
  }

  getData(since?: number): HubLogsData {
    this.selfHeal();
    const records = !this.buffer ? [] : since === undefined ? this.buffer.recent() : this.buffer.since(since);
    return { cursor: this.buffer?.lastSeq ?? -1, dropped: this.buffer?.firstRetainedSeq ?? -1, records };
  }

  onModuleDestroy(): void {
    this.detach();
  }

  onModuleInit(): void {
    this.attach();
  }

  /** Extract the trailing string context param (ConsoleLogger convention) + an error stack. */
  private extract(level: LogLevel, message: unknown, params: unknown[]): BufferedLog | undefined {
    const parts = [...params];
    let context: string | undefined;
    if (parts.length && typeof parts[parts.length - 1] === 'string') {
      context = parts.pop() as string;
    }
    if (context && this.excludeContexts.has(context)) {
      return undefined;
    }
    let stack: string | undefined;
    // For error(), Nest passes [stack, context]; after popping context a trailing stack-ish string remains.
    if (
      level === 'error' &&
      parts.length &&
      typeof parts[parts.length - 1] === 'string' &&
      (parts[parts.length - 1] as string).includes('\n    at ')
    ) {
      stack = (parts.pop() as string).slice(0, 2000);
    }
    const text = this.stringify(message, parts);
    const max = this.cfg?.maxMessageLength ?? 2048;
    // Bound the redaction work: only the first `max` chars are ever shown after truncation, so
    // redacting an arbitrarily large stringified payload is wasted effort. Cap the input to
    // `max` + a margin (so a secret straddling the truncation point is still fully redacted).
    const redactInput = text.length > max + 4096 ? text.slice(0, max + 4096) : text;
    const redacted = redactSensitiveText(redactInput);
    return {
      context,
      level,
      message: redacted.length > max ? redacted.slice(0, max) + '… [truncated]' : redacted,
      seq: 0,
      stack,
      timestamp: 0,
    };
  }

  private push(level: LogLevel, message: unknown, params: unknown[]): void {
    if (!this.buffer || !this.cfg) {
      return;
    }
    if (!this.cfg.levels.includes(level)) {
      return;
    }
    const record = this.extract(level, message, params);
    if (record) {
      this.buffer.add({
        context: record.context,
        level: record.level,
        message: record.message,
        stack: record.stack,
      } as Omit<BufferedLog, 'seq' | 'timestamp'>);
    }
  }

  /** Re-attach if a consumer installed their own logger after us (checked on each read; no timers). */
  private selfHeal(): void {
    if (!this.enabled) {
      return;
    }
    const current = this.staticRef();
    if (current !== this.delegating && current !== undefined) {
      this.attach();
    }
  }

  private staticRef(): LoggerService | undefined {
    return (Logger as unknown as { staticInstanceRef?: LoggerService }).staticInstanceRef;
  }

  private stringify(message: unknown, params: unknown[]): string {
    const one = (value: unknown): string => {
      if (typeof value === 'string') {
        return value;
      }
      if (value instanceof Error) {
        return `${value.name}: ${value.message}`;
      }
      try {
        return JSON.stringify(value);
      } catch {
        return inspect(value, { breakLength: Infinity, depth: 2 });
      }
    };
    return [message, ...params].map(one).join(' | ');
  }
}
