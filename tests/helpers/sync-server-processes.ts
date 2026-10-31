import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A reference server in a process of its own (`tests/helpers/sync-server.process.ts`) */
export interface SyncServerProcess {
  baseUrl: string;
  /** The tail of what the process printed, for a failure message */
  output(): string;
  stop(): Promise<void>;
}

const OUTPUT_LIMIT = 20_000;

/**
 * Start a server process with `overrides` of the e2e configuration and a clock `clockSkewMs` off. Resolves once it
 * listens; rejects with its output when it exits or does not listen within `timeoutMs`.
 */
export async function startSyncServerProcess(
  overrides: Record<string, unknown>,
  clockSkewMs: number,
  timeoutMs = 180_000,
): Promise<SyncServerProcess> {
  const root = process.cwd();
  const child = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(join(root, 'tests', 'helpers', 'skewed-clock.mjs')).href,
      '-r',
      join(root, 'src', 'core', 'modules', 'migrate', 'helpers', 'ts-compiler.js'),
      join(root, 'tests', 'helpers', 'sync-server.process.ts'),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'e2e',
        // Whatever loader options the test runner set apply to its own process, not to this one
        NODE_OPTIONS: '',
        SYNC_CLOCK_SKEW_MS: String(clockSkewMs),
        SYNC_SERVER_CONFIG: JSON.stringify(overrides),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-OUTPUT_LIMIT);
  };
  child.stderr.on('data', collect);
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`The server process did not listen within ${timeoutMs} ms:\n${output}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      collect(chunk);
      const match = /SYNC_SERVER_READY (\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`The server process ended (${code ?? signal}) before it listened:\n${output}`));
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    output: () => output,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const kill = setTimeout(() => child.kill('SIGKILL'), 15_000);
        child.once('exit', () => {
          clearTimeout(kill);
          resolve();
        });
        child.kill('SIGTERM');
      }),
  };
}
