import { PassThrough } from 'stream';

import type { Readable } from 'stream';

/**
 * Marks a stream returned by {@link guardIdleStream}, so a second guard on the same stream is a no-op.
 * A module-private symbol: a property name could arrive on an object from elsewhere, a symbol cannot.
 */
const IDLE_GUARDED = Symbol('lt.idleGuardedStream');

/**
 * Default idle time after which a download stream that makes no read progress is destroyed: 30 s.
 *
 * Long enough for a slow client: a reader that receives any bytes at all resets the timer, so only a
 * transfer that has made NO progress for this long ends. Short enough that a stream nobody reads
 * releases what it holds (an S3 socket, a file handle, a GridFS cursor) within half a minute instead
 * of never.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * Longest delay a Node timer accepts (2^31 - 1 ms, about 24.8 days). A larger delay is clamped by Node to 1 ms — an
 * idle time configured as "practically forever" would otherwise close every download within a millisecond.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Error a guarded stream is destroyed with when it made no read progress for the configured time.
 * Only delivered when someone listens for `error` on the guarded stream (see {@link guardIdleStream}).
 */
export class StreamIdleTimeoutError extends Error {
  readonly code = 'LT_STREAM_IDLE_TIMEOUT';

  constructor(readonly idleMs: number) {
    super(`Download stream made no read progress for ${idleMs} ms and was closed to release its resources`);
    this.name = 'StreamIdleTimeoutError';
  }
}

/**
 * Options of {@link guardIdleStream}.
 */
export interface GuardIdleStreamOptions {
  /**
   * Idle time in milliseconds; a non-positive or non-finite value falls back to {@link DEFAULT_STREAM_IDLE_TIMEOUT_MS},
   * a value above {@link MAX_TIMER_DELAY_MS} is capped there. `false` keeps every other part of the guard (error
   * handling, release on close) but starts no idle timer — for a caller that reads late on purpose.
   */
  idleMs?: false | number;
  /** Called once when the guard closes the stream for lack of progress (logging, metrics). */
  onIdle?: (idleMs: number) => void;
}

/**
 * The stream a guard returns: a `PassThrough` that reports every read of its consumer.
 *
 * Progress has to be measured on the CONSUMER side. The source only delivers when the buffers between it and the
 * reader run low, and those buffers hold several chunks: a slow reader working through them makes progress for
 * a while without the source delivering anything (measured: four 16 KB chunks over 125 ms). Judged by the source
 * alone, such a reader was cut off. `read()` is what every consumer calls — `pipe()` and `'data'` listeners through
 * the stream's flow, async iteration directly — and nothing calls it while nobody reads, which is exactly the
 * stream that must be released.
 */
class IdleGuardStream extends PassThrough {
  onConsumerRead?: () => void;

  override read(size?: number): any {
    this.onConsumerRead?.();
    return super.read(size);
  }
}

/**
 * Whether the stream is already guarded by {@link guardIdleStream}.
 */
export function isIdleGuardedStream(stream: unknown): boolean {
  return !!stream && (stream as Record<symbol, unknown>)[IDLE_GUARDED] === true;
}

/**
 * Wrap a download stream so it releases its source when nobody reads it any more.
 *
 * WHY THIS EXISTS: a download source holds something finite while it is open — an S3 body holds a socket
 * of the SDK's pool, a file stream a file handle, a GridFS stream a server-side cursor. A caller that
 * pipes it with a bare `stream.pipe(res)` stops reading when the client aborts: `pipe()` only unpipes,
 * nothing destroys the source, and it stays paused for the life of the process. For S3 that is a socket
 * taken from a pool of a fixed size; enough aborted downloads and every further S3 request waits forever
 * (measured in production: 50 aborts filled the SDK's default pool, followed by a heap OOM hours later).
 * The same happens to a stream that is obtained and then simply dropped.
 *
 * The guard returns a `PassThrough` the source is piped into. Every read of the consumer, and every chunk the
 * source delivers, resets a timer; nothing resets it while nobody reads (back-pressure pauses the source). When
 * the timer runs out — no read progress for `idleMs` — the source AND the returned stream are destroyed,
 * which releases the socket, handle or cursor. A slow reader that keeps reading is never cut off; only a
 * transfer without ANY progress for the whole period ends.
 *
 * Also: destroying the returned stream (as `pipeFileToResponse()` does when the response closes) destroys
 * the source at once, and an error of the source is forwarded — never left on a stream without a listener,
 * which Node turns into an uncaught exception that ends the process. The idle error itself is only emitted
 * when someone listens for `error` on the returned stream; a stream nobody holds any more is closed
 * silently for the same reason.
 *
 * Guarding an already guarded stream returns it unchanged.
 */
export function guardIdleStream(source: Readable, options: GuardIdleStreamOptions = {}): Readable {
  if (isIdleGuardedStream(source)) {
    return source;
  }
  const idleMs =
    options.idleMs === false
      ? undefined
      : typeof options.idleMs === 'number' && Number.isFinite(options.idleMs) && options.idleMs > 0
        ? Math.min(options.idleMs, MAX_TIMER_DELAY_MS)
        : DEFAULT_STREAM_IDLE_TIMEOUT_MS;

  const guarded = new IdleGuardStream();
  Object.defineProperty(guarded, IDLE_GUARDED, { enumerable: false, value: true });

  let timer: NodeJS.Timeout | undefined;
  const stopTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  // `source.pipe(guarded)` registers an `error` listener of its own on `guarded`, which rethrows when it is the
  // only one. Only listeners beyond it belong to a consumer — counting it made an unread stream's idle error
  // an uncaught exception, the very crash this function exists to prevent.
  let pipeErrorListeners = 0;
  const hasConsumerErrorListener = () => guarded.listenerCount('error') > pipeErrorListeners;

  // An error is only handed on to a consumer's listener; without one, emitting it would end the process
  const destroyGuarded = (error?: Error) => {
    if (guarded.destroyed) {
      return;
    }
    guarded.destroy(error && hasConsumerErrorListener() ? error : undefined);
  };
  const destroySource = () => {
    if (!source.destroyed) {
      source.destroy();
    }
  };

  const onIdle = () => {
    timer = undefined;
    if (source.readableEnded || guarded.destroyed) {
      return;
    }
    try {
      options.onIdle?.(idleMs as number);
    } catch {
      // A failing callback must not keep the resources alive
    }
    destroySource();
    destroyGuarded(new StreamIdleTimeoutError(idleMs as number));
  };
  // Without an idle time (`idleMs: false`) the rest of the guard still applies: the source keeps an error listener —
  // an unread S3 body is destroyed WITH an error by the SDK's socket timeout, which ends the process without one
  if (idleMs !== undefined) {
    timer = setTimeout(onIdle, idleMs);
    // The timer must never keep a process alive on its own (a test run, a graceful shutdown)
    timer.unref?.();
  }

  // Progress: the consumer reads (see `IdleGuardStream`), or the source delivers
  guarded.onConsumerRead = () => timer?.refresh();
  source.on('data', () => timer?.refresh());
  source.once('end', stopTimer);
  source.once('close', stopTimer);
  source.on('error', (error: Error) => {
    stopTimer();
    destroyGuarded(error);
  });
  guarded.once('close', () => {
    stopTimer();
    // The consumer is gone (response closed, stream destroyed): release the source now, not at the timeout
    if (!source.readableEnded) {
      destroySource();
    }
  });

  const before = guarded.listenerCount('error');
  source.pipe(guarded);
  pipeErrorListeners = guarded.listenerCount('error') - before;
  // `pipe()` removes its listener when the source ends; from then on every listener is a consumer's
  source.once('end', () => {
    pipeErrorListeners = 0;
  });
  return guarded;
}
