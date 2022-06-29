/**
 * Wait a certain number of milliseconds
 */
export function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

/**
 * Wait a certain number of milliseconds
 * Alias of sleep
 */
export function wait(ms: number) {
  return sleep(ms);
}
