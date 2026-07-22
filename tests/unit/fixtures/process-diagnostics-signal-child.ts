/**
 * Child fixture for the real-signal test (`../process-diagnostics-signal.spec.ts`).
 *
 * Installs the REAL diagnostics on the REAL `process` and then keeps the event loop busy, the way
 * a listening HTTP server does. That last part is the whole point: without a non-empty loop the
 * process would exit on its own and the test would pass without proving anything about signals.
 *
 * Not a `*.spec.ts`, so neither vitest runner picks it up as a suite.
 */
import { installProcessDiagnostics } from '../../../src/core/common/helpers/process-diagnostics.helper';

installProcessDiagnostics();

// Hold the event loop open, exactly like `server.listen()` does. `unref()` is deliberately NOT
// called: an unref'd timer would let the process exit by itself, which is precisely the false
// positive this fixture must not produce.
setInterval(() => undefined, 1_000);

process.stdout.write('READY\n');
