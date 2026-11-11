/**
 * `guardIdleStream()` — a download stream nobody reads releases its source; a slow reader is never cut off.
 *
 * The source stands in for an S3 body (a socket of the SDK's pool), a file handle or a GridFS cursor: what
 * matters is whether it is DESTROYED, because only that releases what it holds. Production saw the opposite —
 * aborted downloads piped with a bare `stream.pipe(res)` kept their S3 sockets for good, until the pool of 50 was
 * full and every S3 request hung.
 */
import { PassThrough, Readable, Writable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';

import {
  guardIdleStream,
  isIdleGuardedStream,
  StreamIdleTimeoutError,
} from '../../src/core/common/helpers/idle-stream.helper';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A source that has more data than fits into the stream buffers, delivered on demand — one chunk per event-loop
 * turn, like a socket, so a flowing consumer cannot starve the timers the tests wait on.
 */
function endlessSource(): Readable {
  return new Readable({
    read() {
      setImmediate(() => this.push(Buffer.alloc(16 * 1024, 1)));
    },
  });
}

const uncaught: unknown[] = [];
const onUncaught = (error: unknown) => uncaught.push(error);
process.on('uncaughtException', onUncaught);

afterEach(() => {
  expect(uncaught).toEqual([]);
  uncaught.length = 0;
});

describe('guardIdleStream', () => {
  /**
   * @regression   11.46.3 — an S3 download stream that was dropped, or piped with a bare `pipe()` to a client that
   *   aborted, held its socket for the life of the process; 50 of them filled the SDK's pool (production outage).
   * @seen-failing Never start the idle timer in guardIdleStream() (src/core/common/helpers/idle-stream.helper.ts) —
   *   registered as mutation `idle-guard-never-fires` in tests/regression-mutations.json.
   */
  it('destroys a source nobody reads after the idle time, without an uncaught error', async () => {
    const source = endlessSource();
    const idled: number[] = [];
    const guarded = guardIdleStream(source, { idleMs: 100, onIdle: (ms) => idled.push(ms) });

    await sleep(300);
    expect(source.destroyed).toBe(true);
    expect(guarded.destroyed).toBe(true);
    expect(idled).toEqual([100]);
  });

  it('releases a source whose consumer stopped reading after a raw pipe() lost its destination', async () => {
    const source = endlessSource();
    const guarded = guardIdleStream(source, { idleMs: 100 });
    // A bare pipe to a destination that goes away — what an aborted HTTP response does to `pipe()`
    const destination = new PassThrough();
    guarded.pipe(destination);
    destination.resume();
    await sleep(30);
    guarded.unpipe(destination);
    destination.destroy();

    await sleep(300);
    expect(source.destroyed).toBe(true);
  });

  /**
   * @regression   11.46.3 — the idle guard must measure PROGRESS, not age: a slow client that keeps reading must
   *   receive the whole file.
   * @seen-failing Reset the timer on neither consumer reads nor source data in guardIdleStream()
   *   (src/core/common/helpers/idle-stream.helper.ts) — registered as mutation `idle-guard-ignores-progress` in
   *   tests/regression-mutations.json.
   */
  /**
   * @regression   11.46.3 (found while testing) — progress was judged by the source alone; a slow reader working
   *   through the buffers between source and consumer (several chunks) made progress without the source
   *   delivering, and was cut off.
   * @seen-failing Stop resetting the timer on consumer reads in guardIdleStream()
   *   (src/core/common/helpers/idle-stream.helper.ts) — registered as mutation `idle-guard-judges-source-only` in
   *   tests/regression-mutations.json.
   */
  it('never cuts off a slow reader that keeps reading, even far beyond the idle time', async () => {
    // More than the stream buffers hold, so the source cannot end early and the guard must judge PROGRESS
    const chunkSize = 16 * 1024;
    const chunks = 40;
    let sent = 0;
    const source = new Readable({
      highWaterMark: chunkSize,
      read() {
        this.push(sent++ < chunks ? Buffer.alloc(chunkSize, 2) : null);
      },
    });
    const guarded = guardIdleStream(source, { idleMs: 120 });
    let received = 0;
    const started = Date.now();
    const slowReader = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        // Each chunk takes a quarter of the idle time: the whole transfer lasts many idle periods
        setTimeout(callback, 30);
      },
    });

    await new Promise<void>((resolve, reject) => {
      guarded.on('error', reject);
      guarded.on('close', () => (received < chunks * chunkSize ? reject(new Error(`cut off at ${received}`)) : undefined));
      slowReader.on('finish', resolve);
      guarded.pipe(slowReader);
    });
    expect(received).toBe(chunks * chunkSize);
    expect(Date.now() - started).toBeGreaterThan(120 * 4);
  });

  it('destroys the source at once when the consumer destroys the guarded stream', async () => {
    const source = endlessSource();
    const guarded = guardIdleStream(source, { idleMs: 10_000 });
    guarded.resume();
    await sleep(20);
    guarded.destroy();
    await sleep(20);
    expect(source.destroyed).toBe(true);
  });

  it('hands a source error to a listener, and swallows it when nobody listens instead of ending the process', async () => {
    const listened = new PassThrough();
    const guardedWithListener = guardIdleStream(listened, { idleMs: 10_000 });
    const errors: Error[] = [];
    guardedWithListener.on('error', (error) => errors.push(error));
    listened.destroy(new Error('missing chunks'));

    const unlistened = new PassThrough();
    const guardedWithoutListener = guardIdleStream(unlistened, { idleMs: 10_000 });
    unlistened.destroy(new Error('socket timed out'));

    await sleep(20);
    expect(errors.map((error) => error.message)).toEqual(['missing chunks']);
    expect(guardedWithoutListener.destroyed).toBe(true);
  });

  it('reports the idle time as StreamIdleTimeoutError to a listener', async () => {
    const guarded = guardIdleStream(endlessSource(), { idleMs: 50 });
    const error = await new Promise<Error>((resolve) => guarded.on('error', resolve));
    expect(error).toBeInstanceOf(StreamIdleTimeoutError);
    expect((error as StreamIdleTimeoutError).idleMs).toBe(50);
  });

  it('leaves a completely read stream alone and guards a stream only once', async () => {
    const source = Readable.from([Buffer.from('ab'), Buffer.from('cd')]);
    const guarded = guardIdleStream(source, { idleMs: 50 });
    expect(isIdleGuardedStream(guarded)).toBe(true);
    expect(guardIdleStream(guarded)).toBe(guarded);

    const parts: Buffer[] = [];
    for await (const chunk of guarded) {
      parts.push(chunk as Buffer);
    }
    expect(Buffer.concat(parts).toString()).toBe('abcd');
    await sleep(120);
    expect(source.readableEnded).toBe(true);
  });

  it('keeps error handling and release on close without a timer when idleMs is false', async () => {
    const source = endlessSource();
    const guarded = guardIdleStream(source, { idleMs: false });
    await sleep(150);
    expect(source.destroyed).toBe(false);

    const errors: Error[] = [];
    guarded.on('error', (error) => errors.push(error));
    source.destroy(new Error('socket timed out'));
    await sleep(20);
    expect(errors.map((error) => error.message)).toEqual(['socket timed out']);
  });

  /**
   * @regression   11.46.3 (found in review) — an idle time above 2^31 - 1 ms ("practically forever") was clamped by
   *   Node to 1 ms: every download closed within a millisecond.
   * @seen-failing Drop the cap at MAX_TIMER_DELAY_MS in guardIdleStream() (src/core/common/helpers/idle-stream.helper.ts)
   *   — registered as mutation `idle-guard-timer-overflow` in tests/regression-mutations.json.
   */
  it('caps an idle time above the longest Node timer instead of firing at once', async () => {
    for (const idleMs of [2 ** 31, Number.MAX_SAFE_INTEGER]) {
      const source = endlessSource();
      const guarded = guardIdleStream(source, { idleMs });
      await sleep(50);
      expect(source.destroyed).toBe(false);
      guarded.destroy();
    }
  });

  it('falls back to the default for a non-positive or non-numeric idle time', () => {
    for (const idleMs of [0, -1, Number.NaN, '5' as unknown as number]) {
      const source = endlessSource();
      const guarded = guardIdleStream(source, { idleMs });
      expect(isIdleGuardedStream(guarded)).toBe(true);
      guarded.destroy();
    }
  });
});
