#!/usr/bin/env node

/**
 * Add type references to the generated index.d.ts file
 * This ensures that ambient module declarations are available to library consumers
 */

const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'dist', 'index.d.ts');

// Type references to add
const typeReferences = ['/// <reference path="./types/graphql-upload.d.ts" />'];

try {
  const content = fs.readFileSync(indexPath, 'utf8');
  const newContent = `${typeReferences.join('\n')}\n${content}`;
  fs.writeFileSync(indexPath, newContent);
  console.debug('✓ Type references added to index.d.ts');
} catch (error) {
  console.error('✗ Failed to add type references:', error.message);
  process.exit(1);
}
