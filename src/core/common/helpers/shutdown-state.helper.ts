/**
 * Whether the application has started to shut down (12.11.0) — an import-free leaf, so `installGracefulShutdown()` and
 * the health check's readiness endpoint reach the same state without importing each other.
 *
 * `installGracefulShutdown()` marks it on the first SIGTERM / SIGINT, BEFORE the `shutdownDelayMs` wait. From then on
 * `GET /health-check/ready` answers 503 (`shutting_down`) while the liveness check stays healthy: a load balancer that
 * polls readiness takes the replica out of rotation during the wait, and the process is not restarted. Terminus' own
 * shutdown state comes only inside `app.close()`, right before the HTTP server closes — too late for any poll.
 *
 * Process-wide, like the signals it follows.
 */

let draining = false;

/** Marks the start of the shutdown. */
export function markShutdownDraining(): void {
  draining = true;
}

/** Whether the shutdown has started. */
export function isShutdownDraining(): boolean {
  return draining;
}

/** Resets the state — for tests. */
export function resetShutdownDraining(): void {
  draining = false;
}
