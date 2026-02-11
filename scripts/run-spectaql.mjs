#!/usr/bin/env node
/**
 * Wrapper script for spectaql that filters Sass deprecation warnings
 *
 * Sass deprecation warnings come from spectaql's internal dependencies
 * and cannot be silenced through configuration. This script filters them
 * from the output while preserving the exit code.
 */

import { spawn } from 'child_process';

const spectaql = spawn('pnpm', ['dlx', 'spectaql', './spectaql.yml'], {
  stdio: ['inherit', 'pipe', 'pipe'],
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
