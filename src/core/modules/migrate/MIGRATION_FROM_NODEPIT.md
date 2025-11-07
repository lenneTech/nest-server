# Migration from @nodepit/migrate-state-store-mongodb

This guide provides step-by-step instructions to migrate from `@nodepit/migrate-state-store-mongodb` to the built-in nest-server migration system.

## Prerequisites

Current state of nest-server-starter projects:
- Using `@nodepit/migrate-state-store-mongodb` for state storage
- Using external `migrate` package for CLI
- Custom migration utilities in `migrations-utils/`

## Migration Steps

### Step 1: Update Dependencies

**File:** `package.json`

Remove old migration packages:
```bash
npm uninstall migrate @nodepit/migrate-state-store-mongodb ts-migrate-mongoose
```

Ensure latest nest-server is installed:
```bash
npm install @lenne.tech/nest-server@latest
```

### Step 2: Update Migration State Store

**File:** `migrations-utils/migrate.js`

**Before:**
```javascript
import config from '../src/config.env';
const migrate = require('migrate');
const { MongoStateStore } = require('@nodepit/migrate-state-store-mongodb');

const MONGO_URL = config.mongoose.uri;
const COLLECTION_NAME = 'migrations';

module.exports = class MyMongoStateStore extends MongoStateStore {
  constructor() {
    super({ uri: MONGO_URL, collectionName: COLLECTION_NAME });
  }
};
```

**After:**
```javascript
const { createMigrationStore } = require('@lenne.tech/nest-server');
const config = require('../src/config.env');

module.exports = createMigrationStore(
  config.default.mongoose.uri,
  'migrations' // optional, default is 'migrations'
);
```

### Step 3: Update Database Helper

**File:** `migrations-utils/db.ts`

**Before:**
```typescript
import * as fs from 'fs';
import { GridFSBucket, MongoClient, ObjectId } from 'mongodb';
import * as path from 'path';
import config from '../src/config.env';

const MONGO_URL = config.mongoose.uri;

export const getDb = async () => {
  const client: MongoClient = await MongoClient.connect(MONGO_URL);
  return client.db();
};

export const uploadFile = async (
  relativePath,
  options?: { bucketName?: string; filename?: string },
): Promise<ObjectId> => {
  // ... implementation
};
```

**After:**
```typescript
import config from '../src/config.env';
import { getDb as getDbHelper, uploadFileToGridFS } from '@lenne.tech/nest-server';
import { Db, ObjectId } from 'mongodb';

const MONGO_URL = config.mongoose.uri;

/**
 * Get database connection
 */
export const getDb = async (): Promise<Db> => {
  return getDbHelper(MONGO_URL);
};

/**
 * Upload file to GridFS
 */
export const uploadFile = async (
  relativePath: string,
  options?: { bucketName?: string; filename?: string }
): Promise<ObjectId> => {
  return uploadFileToGridFS(MONGO_URL, relativePath, options);
};
```

### Step 4: Verify package.json Scripts

**File:** `package.json`

Scripts should remain unchanged - they will work with the built-in CLI:

```json
{
  "scripts": {
    "migrate:create": "migrate create --template-file ./migrations-utils/template.ts --migrations-dir=\"./migrations\" --compiler=\"ts:./migrations-utils/ts-compiler.js\"",
    "migrate:up": "migrate --store=./migrations-utils/migrate.js --migrations-dir=\"./migrations\" --compiler=\"ts:./migrations-utils/ts-compiler.js\" up",
    "migrate:develop:up": "NODE_ENV=develop migrate --store=./migrations-utils/migrate.js --migrations-dir=\"./migrations\" --compiler=\"ts:./migrations-utils/ts-compiler.js\" up",
    "migrate:test:up": "NODE_ENV=test migrate --store=./migrations-utils/migrate.js --migrations-dir=\"./migrations\" --compiler=\"ts:./migrations-utils/ts-compiler.js\" up",
    "migrate:preview:up": "NODE_ENV=preview migrate --store=./migrations-utils/migrate.js --migrations-dir=\"./migrations\" --compiler=\"ts:./migrations-utils/ts-compiler.js\" up",
    "migrate:prod:up": "NODE_ENV=production migrate --store=./migrations-utils/migrate.js --migrations-dir=\"./migrations\" --compiler=\"ts:./migrations-utils/ts-compiler.js\" up"
  }
}
```

Note: The `migrate` command now comes from `@lenne.tech/nest-server` - no external package needed.

### Step 5: Test Migration

```bash
# Install dependencies
npm install

# Test migration creation
npm run migrate:create -- test-migration

# Test migration execution (if safe in current environment)
npm run migrate:up
```

## Verification Checklist

- [ ] `migrate` package removed from package.json
- [ ] `@nodepit/migrate-state-store-mongodb` removed from package.json
- [ ] `ts-migrate-mongoose` removed from package.json
- [ ] `migrations-utils/migrate.js` updated to use `createMigrationStore`
- [ ] `migrations-utils/db.ts` updated to use nest-server helpers
- [ ] `npm install` completed successfully
- [ ] `npm run migrate:create -- test` works
- [ ] Existing migrations still in database (no data loss)

## What Stays the Same

- ✅ All migration files in `migrations/` folder
- ✅ All migration data in MongoDB
- ✅ All npm scripts in package.json
- ✅ Migration file format (up/down functions)
- ✅ Template files (if using custom templates)

## What Changes

- ✅ `migrations-utils/migrate.js` - simplified (3 lines)
- ✅ `migrations-utils/db.ts` - uses nest-server helpers
- ✅ package.json dependencies - 2-3 packages removed
- ✅ CLI comes from nest-server instead of external package

## Rollback (if needed)

If you need to rollback:

```bash
# Reinstall old packages
npm install --save-dev migrate @nodepit/migrate-state-store-mongodb

# Revert migrations-utils/migrate.js to old version from git
git checkout migrations-utils/migrate.js

# Revert migrations-utils/db.ts to old version from git
git checkout migrations-utils/db.ts
```

## Benefits After Migration

1. **One less dependency** - No external `migrate` package needed
2. **Simplified code** - ~90% less boilerplate in migrations-utils
3. **Better TypeScript** - Native TypeScript implementation
4. **MongoDB 7.x support** - Works with latest MongoDB versions
5. **Central maintenance** - Updates come with nest-server

## Support

If issues occur during migration:
- Check that `@lenne.tech/nest-server` is at version 11.3.0 or higher
- Verify `ts-node` is installed as devDependency
- Ensure `migrations-utils/migrate.js` exports the state store correctly
- Test with `migrate --help` to verify CLI is available

## File Structure After Migration

```
project-root/
├── migrations/                    # Unchanged
│   └── TIMESTAMP-*.ts            # Your migrations
├── migrations-utils/
│   ├── migrate.js                # Updated (3 lines)
│   ├── db.ts                     # Updated (uses nest-server helpers)
│   ├── template.ts               # Unchanged (optional)
│   └── ts-compiler.js            # Unchanged (optional, can be removed)
└── package.json                  # Dependencies removed
```

Note: `ts-compiler.js` can optionally be removed and replaced with:
```
--compiler="ts:./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/helpers/ts-compiler.js"
```
