#!/usr/bin/env node

/**
 * Migration CLI wrapper
 *
 * This is a shim that makes the nest-server migration CLI available as "migrate"
 * for drop-in compatibility with projects using the @nodepit/migrate package.
 */

const fs = require('fs');
// Check if running from built dist or src
const path = require('path');

const distPath = path.join(__dirname, '../dist/core/modules/migrate/cli/migrate-cli.js');
const srcPath = path.join(__dirname, '../src/core/modules/migrate/cli/migrate-cli.ts');

let cliPath;

if (fs.existsSync(distPath)) {
  // Production: use built version
  cliPath = distPath;
} else if (fs.existsSync(srcPath)) {
  // Development: register ts-node and use source
  try {
    require('ts-node/register');
    cliPath = srcPath;
  } catch (e) {
    console.error('Error: ts-node is required in development mode');
    console.error('Install it with: npm install --save-dev ts-node');
    process.exit(1);
  }
} else {
  console.error('Error: Migration CLI not found');
  console.error('Make sure @lenne.tech/nest-server is properly built');
  process.exit(1);
}

// Load and run the CLI
const { main } = require(cliPath);
main();
