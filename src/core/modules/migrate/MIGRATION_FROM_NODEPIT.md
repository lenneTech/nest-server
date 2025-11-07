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

The `migrate` CLI is now provided by `@lenne.tech/nest-server` - no external package needed!

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

### Step 3: Update or Remove Utility Files

**The following files should be updated or deleted:**

#### 🔄 Update `migrations-utils/db.ts` to Proxy (Recommended for backwards compatibility)

**Option A: Create a simple re-export proxy** (Recommended)

This keeps old migrations working without modifications:

```typescript
/**
 * Legacy compatibility layer for old migrations
 * Re-exports database and migration helpers from @lenne.tech/nest-server
 */
export { createMigrationStore, getDb, uploadFileToGridFS } from '@lenne.tech/nest-server';
```

**Option B: Delete and update all migrations** (Not recommended)

Delete the file and update all existing migration files to import directly from `@lenne.tech/nest-server`:
```typescript
// Old (in migrations)
import { getDb } from '../migrations-utils/db';

// New (in migrations)
import { getDb } from '@lenne.tech/nest-server';
```

**We recommend Option A** to maintain backwards compatibility with existing migrations.

#### ❌ Delete `migrations-utils/template.ts`
Use the built-in project template from nest-server instead.

#### ❌ Delete `migrations-utils/ts-compiler.js`
The TypeScript compiler is now provided by nest-server.

**Files to keep:**
- ✅ `migrations-utils/migrate.js` (project-specific configuration)
- ✅ `migrations-utils/db.ts` (optional proxy for backwards compatibility)

### Step 4: Update package.json Scripts

**File:** `package.json`

**IMPORTANT:** The CLI syntax has changed. The command must come FIRST, then the options.

**Before (WRONG):**
```json
{
  "scripts": {
    "migrate:create": "migrate create --template-file ./migrations-utils/template.ts --migrations-dir=\"./migrations\" --compiler=\"ts:./migrations-utils/ts-compiler.js\"",
    "migrate:up": "migrate --store=./migrations-utils/migrate.js --migrations-dir=\"./migrations\" --compiler=\"ts:./migrations-utils/ts-compiler.js\" up"
  }
}
```

**After (CORRECT):**
```json
{
  "scripts": {
    "migrate:create": "migrate create --template-file ./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/templates/migration-project.template.ts --migrations-dir ./migrations --compiler ts:./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/helpers/ts-compiler.js",
    "migrate:up": "migrate up --store ./migrations-utils/migrate.js --migrations-dir ./migrations --compiler ts:./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/helpers/ts-compiler.js",
    "migrate:down": "migrate down --store ./migrations-utils/migrate.js --migrations-dir ./migrations --compiler ts:./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/helpers/ts-compiler.js",
    "migrate:list": "migrate list --store ./migrations-utils/migrate.js --migrations-dir ./migrations --compiler ts:./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/helpers/ts-compiler.js",
    "migrate:develop:up": "NODE_ENV=develop migrate up --store ./migrations-utils/migrate.js --migrations-dir ./migrations --compiler ts:./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/helpers/ts-compiler.js",
    "migrate:test:up": "NODE_ENV=test migrate up --store ./migrations-utils/migrate.js --migrations-dir ./migrations --compiler ts:./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/helpers/ts-compiler.js",
    "migrate:preview:up": "NODE_ENV=preview migrate up --store ./migrations-utils/migrate.js --migrations-dir ./migrations --compiler ts:./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/helpers/ts-compiler.js",
    "migrate:prod:up": "NODE_ENV=production migrate up --store ./migrations-utils/migrate.js --migrations-dir ./migrations --compiler ts:./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/helpers/ts-compiler.js"
  }
}
```

**Key changes:**
- ✅ Command (`up`, `down`, `create`, `list`) comes FIRST
- ✅ Use `ts:./path` instead of `"ts:./path"` for compiler
- ✅ Remove quotes around paths (not needed)
- ✅ Use nest-server paths for template and compiler

### Step 5: Test Migration

```bash
# Install dependencies
npm install

# Test migration creation
npm run migrate:create -- test-migration

# Test migration status
npm run migrate:list

# Clean up test migration
rm migrations/*-test-migration.ts
```

## Verification Checklist

- [ ] `migrate` package removed from package.json
- [ ] `@nodepit/migrate-state-store-mongodb` removed from package.json
- [ ] `ts-migrate-mongoose` removed from package.json (if present)
- [ ] `migrations-utils/migrate.js` updated to use `createMigrationStore`
- [ ] `migrations-utils/db.ts` **updated to proxy** or deleted (recommended: create proxy for backwards compatibility)
- [ ] `migrations-utils/template.ts` **deleted** (use nest-server template)
- [ ] `migrations-utils/ts-compiler.js` **deleted** (use nest-server compiler)
- [ ] package.json scripts updated with correct syntax
- [ ] `npm install` completed successfully
- [ ] `npm run migrate:create -- test` works
- [ ] Existing migrations still in database (no data loss)

## What Stays the Same

- ✅ All migration files in `migrations/` folder
- ✅ All migration data in MongoDB
- ✅ Migration state collection (`migrations`)
- ✅ npm script names (can keep existing names)

## What Changes

### Files Removed (2 files)
- ❌ `migrations-utils/template.ts` - **DELETED** (use nest-server template)
- ❌ `migrations-utils/ts-compiler.js` - **DELETED** (use nest-server compiler)

### Files Updated (2 files)
- ✅ `migrations-utils/migrate.js` - simplified from ~14 lines to ~7 lines
- ✅ `migrations-utils/db.ts` - converted to simple re-export proxy (~5 lines)

### Files Kept
- ✅ `migrations-utils/migrate.js` - **REQUIRED** (project-specific configuration)
- ✅ `migrations-utils/db.ts` - **OPTIONAL** (backwards compatibility proxy)

### Other Changes
- ✅ package.json scripts syntax updated
- ✅ CLI comes from nest-server instead of external package

## Rollback (if needed)

If you need to rollback:

```bash
# Reinstall old packages
npm install --save-dev migrate @nodepit/migrate-state-store-mongodb

# Restore old files from git
git checkout migrations-utils/migrate.js
git checkout migrations-utils/db.ts
git checkout migrations-utils/template.ts
git checkout migrations-utils/ts-compiler.js
git checkout package.json
```

## Benefits After Migration

1. **85% less boilerplate** - Only 1-2 small files instead of 4 in migrations-utils
2. **No external dependencies** - `migrate` CLI comes from nest-server
3. **Better TypeScript** - Native TypeScript implementation
4. **MongoDB 7.x support** - Works with latest MongoDB versions
5. **Central maintenance** - Updates come with nest-server
6. **Consistent across projects** - All projects use same utilities

## Migration Template Usage

After migration, your migrations will look like this:

```typescript
import { getDb, uploadFileToGridFS } from '@lenne.tech/nest-server';
import { Db, ObjectId } from 'mongodb';
import config from '../src/config.env';

const MONGO_URL = config.mongoose.uri;

export const up = async () => {
  const db: Db = await getDb(MONGO_URL);

  // Your migration code here
  await db.collection('users').updateMany(
    { email: { $exists: false } },
    { $set: { email: '' } }
  );
};

export const down = async () => {
  const db: Db = await getDb(MONGO_URL);

  // Your rollback code here
  await db.collection('users').updateMany(
    {},
    { $unset: { email: '' } }
  );
};
```

**No need to create helper files!** All utilities are imported directly from `@lenne.tech/nest-server`.

## Support

If issues occur during migration:
- Check that `@lenne.tech/nest-server` is at version 11.3.0 or higher
- Verify `ts-node` is installed as devDependency
- Ensure `migrations-utils/migrate.js` exports the state store correctly
- Test with `migrate --help` to verify CLI is available
- Remember: Command must come FIRST in CLI syntax

## File Structure After Migration

```
project-root/
├── migrations/                    # Unchanged
│   └── TIMESTAMP-*.ts            # Your migrations
├── migrations-utils/
│   ├── migrate.js                # ⭐ REQUIRED (7 lines)
│   └── db.ts                     # ⭐ OPTIONAL proxy (5 lines, for backwards compatibility)
└── package.json                  # Scripts updated
```

**Everything else comes from `@lenne.tech/nest-server`!**

**Note:** The `db.ts` file is optional but recommended to keep old migrations working without modifications.

## CLI Command Reference

```bash
# Create new migration
migrate create <name> --template-file <path> --migrations-dir <dir> --compiler ts:<path>

# Run all pending migrations
migrate up --store <path> --migrations-dir <dir> --compiler ts:<path>

# Rollback last migration
migrate down --store <path> --migrations-dir <dir> --compiler ts:<path>

# List migration status
migrate list --store <path> --migrations-dir <dir> --compiler ts:<path>
```

**Key points:**
- Command (`create`, `up`, `down`, `list`) comes FIRST
- Options use `--option value` format (not `--option=value`)
- Compiler format: `ts:./path` (not `"ts:./path"`)