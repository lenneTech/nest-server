'use strict';

// Start timer
console.time('duration');

// =====================================================================================================================
// Import packages and data
// =====================================================================================================================

// Get require function
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Import packages
import fs from 'fs';

// Get directory path
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =====================================================================================================================
// Operations
// =====================================================================================================================

// Get package.json
console.log('Get package.json');
const packageJson = require('../package.json');
if (!packageJson) {
  console.log('Missing package.json');
  process.exit(1);
}

// Get version
const version = packageJson?.version;
if (!version) {
  console.log('Please version in package.json');
  process.exit(1);
}
console.log('Found version ' + version);

// Get data
let spectaql;
try {
  spectaql = fs.readFileSync(__dirname + '/../spectaql.yml', { encoding: 'utf8' });
} catch (e) {
  console.log(e);
  process.exit(1);
}

// Replace string
const replaced = spectaql.replace(/(version\s*:\s*).*/, '$1' + version);

// Write changes
try {
  fs.writeFileSync(__dirname + '/../spectaql.yml', replaced);
} catch (e) {
  console.log(e);
  process.exit(1);
}

// Done
console.timeEnd('duration');
