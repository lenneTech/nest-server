import { describe, expect, it, vi } from 'vitest';

import { sendAuthEmailSafely } from '../../src/core/modules/better-auth/better-auth.config';

/**
 * Regression guard: an auth email (verification / password-reset) is sent
 * fire-and-forget so it cannot leak timing information about whether an account
 * exists. But a rejected send must NEVER surface as an unhandled promise
 * rejection — that crashes the Node process (observed in dev: signing up an
 * unverified user then signing in took the whole API down when SMTP was not
 * configured and the verification-mail send rejected).
 *
 * `sendAuthEmailSafely` must therefore: stay non-blocking, catch BOTH sync
 * throws and async rejections, routing them to the onError logger instead —
 * and never crash even when onError itself throws.
 */
describe('sendAuthEmailSafely', () => {
  // Macrotask boundary (not just a microtask flush): Node emits
  // 'unhandledRejection' only after the microtask queue has drained, so the
  // unhandled-rejection tests below need a real task hop to observe it.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('routes an async rejection to onError instead of leaving it unhandled', async () => {
    const onError = vi.fn();
    const err = new Error('SMTP down');
    sendAuthEmailSafely(() => Promise.reject(err), onError);
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('catches a synchronous throw from the send callback', async () => {
    const onError = vi.fn();
    sendAuthEmailSafely(() => {
      throw new Error('boom');
    }, onError);
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('does not call onError when the send succeeds', async () => {
    const onError = vi.fn();
    sendAuthEmailSafely(() => Promise.resolve('sent'), onError);
    await flush();
    expect(onError).not.toHaveBeenCalled();
  });

  it('is non-blocking — it returns before a slow send resolves', async () => {
    const onError = vi.fn();
    let sendResolved = false;
    sendAuthEmailSafely(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            sendResolved = true;
            resolve(undefined);
          }, 50);
        }),
      onError,
    );
    // The helper returned synchronously; the send has NOT completed yet.
    expect(sendResolved).toBe(false);
    await flush();
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not produce an unhandled rejection for a rejecting send', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      sendAuthEmailSafely(() => Promise.reject(new Error('no smtp')), vi.fn());
      await flush();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not produce an unhandled rejection when onError itself throws', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      sendAuthEmailSafely(
        () => Promise.reject(new Error('send failed')),
        () => {
          throw new Error('logger transport failed');
        },
      );
      await flush();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
