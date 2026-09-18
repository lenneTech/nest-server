#!/usr/bin/env node
/**
 * Wrapper script for spectaql that filters Sass deprecation warnings
 *
 * Sass deprecation warnings come from spectaql's internal dependencies
 * and cannot be silenced through configuration. This script filters them
 * from the output while preserving the exit code.
 */

import { spawn } from 'child_process';

// `shell: true` because on Windows `pnpm` is not an executable but a shim, and Node has
// refused to run .cmd/.bat files directly since 20.12 (the CVE-2024-27980 hardening). A bare
// spawn therefore dies with `spawn pnpm ENOENT` (errno -4058) there, which is what a Windows
// laptop hit on 2026-09-16. Naming `pnpm.cmd` for win32 would guess the install method — the
// shim is .cmd via npm/corepack but .exe from the standalone installer.
//
// One literal command string rather than an args array: every argument here is fixed and
// nothing is interpolated, so the shell has nothing to expand — and an args array next to
// `shell: true` triggers Node's DEP0190 warning on every run.
const spectaql = spawn('pnpm dlx spectaql ./spectaql.yml', {
  shell: true,
  stdio: ['inherit', 'pipe', 'pipe'],
});

// Not the Windows fix, and worth separating: behind a shell a missing command comes back as
// exit code 127 through `close`, never as an `error` event. What remains for this handler is
// the shell itself failing to start — and without it that event is unhandled and throws. In a
// generated project it would throw after a SUCCESSFUL boot, because config.env.ts runs
// `pnpm run docs:bootstrap` through execAfterInit. Killing a running server because a docs
// tool could not start is the wrong trade.
spectaql.on('error', (error) => {
  console.error(`[run-spectaql] could not start pnpm: ${error.message}`);
  process.exit(1);
});

// Patterns to filter from output (Sass deprecation warnings)
const filterPatterns = [
  'DEPRECATION WARNING',
  'More info and automated migrator:',
  'sass-lang.com',
  '───', // Box drawing characters
  '│', // Vertical line in Sass output
  '╵', // Bottom corner
  '╷', // Top corner
  '@import', // Import statements in warnings
  'root stylesheet',
];

function shouldFilter(line) {
  return filterPatterns.some((pattern) => line.includes(pattern));
}

function processOutput(data, stream) {
  const lines = data.toString().split('\n');
  const filtered = lines.filter((line) => !shouldFilter(line));
  const output = filtered.join('\n');
  if (output.trim()) {
    stream.write(output + (output.endsWith('\n') ? '' : '\n'));
  }
}

spectaql.stdout.on('data', (data) => {
  processOutput(data, process.stdout);
});

spectaql.stderr.on('data', (data) => {
  processOutput(data, process.stderr);
});

spectaql.on('close', (code) => {
  process.exit(code);
});
