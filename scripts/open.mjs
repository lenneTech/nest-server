#!/usr/bin/env node
/**
 * Opens URLs or files with the platform's default handler.
 *
 * Replaces the macOS-only `open` in the `docs` script. Ported from nest-server-starter. Not replaced
 * by `start` either: under cmd.exe that is a builtin whose first quoted argument becomes the window
 * title, and under PowerShell it is something else entirely. `rundll32 url.dll,FileProtocolHandler`
 * is a real executable, takes the target as a plain argument, and handles URLs and files alike.
 *
 * Usage: node scripts/open.mjs <url-or-file> [...]
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which program opens `target` on `platform`. Pure, so all three branches can be tested from any
 * platform without opening anything.
 */
export function openPlan(target, platform = process.platform) {
  if (platform === 'darwin') {
    return { args: [target], command: 'open' };
  }
  if (platform === 'win32') {
    return { args: ['url.dll,FileProtocolHandler', target], command: 'rundll32' };
  }
  return { args: [target], command: 'xdg-open' };
}

/**
 * URLs pass through; everything else is a file and becomes absolute, because the Windows handler
 * does not resolve a relative path against the caller's working directory.
 */
export function resolveTarget(arg, cwd = process.cwd()) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ? arg : resolve(cwd, arg);
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  for (const arg of process.argv.slice(2)) {
    const plan = openPlan(resolveTarget(arg));
    execFileSync(plan.command, plan.args, { stdio: 'inherit' });
  }
}
