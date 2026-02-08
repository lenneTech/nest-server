# MongoDB State Store for Migrations

This module provides a MongoDB-based state storage for migration frameworks, offering a modern TypeScript implementation that is fully compatible with `@nodepit/migrate-state-store-mongodb`.

## Features

- ✅ **Full Backward Compatibility**: Drop-in replacement for `@nodepit/migrate-state-store-mongodb`
- ✅ **MongoDB 6+ Support**: Works with MongoDB 6.x, 7.x and newer versions
- ✅ **Modern TypeScript**: Written in modern TypeScript with full type safety
- ✅ **Cluster Support**: Built-in locking mechanism for clustered environments
- ✅ **Dual API**: Supports both callback-based and Promise-based APIs
- ✅ **No External Dependencies**: Uses only MongoDB driver already included in nest-server
- ✅ **Fully Tested**: Comprehensive E2E test suite with 25+ test cases

## Migration from @nodepit/migrate-state-store-mongodb

If you're currently using `@nodepit/migrate-state-store-mongodb`, you can migrate seamlessly:

### 1. Remove the old package

```bash
npm uninstall @nodepit/migrate-state-store-mongodb
```

### 2. Update your imports

**Before:**

```typescript
import { MongoStateStore, synchronizedUp } from '@nodepit/migrate-state-store-mongodb';
```

**After:**

```typescript
import { MongoStateStore, synchronizedUp } from '@lenne.tech/nest-server';
```

That's it! Your existing migrations will continue to work without any changes.

## Installation

If you're using `@lenne.tech/nest-server`, the migration functionality is already included:

```bash
npm install @lenne.tech/nest-server
```

## Usage

### Basic Usage

```typescript
import { MongoStateStore } from '@lenne.tech/nest-server';

// Simple string URI
const stateStore = new MongoStateStore('mongodb://localhost/mydb');

// Or with options
const stateStore = new MongoStateStore({
  uri: 'mongodb://localhost/mydb',
  collectionName: 'custom_migrations', // optional, defaults to 'migrations'
  lockCollectionName: 'migration_lock', // optional, for cluster environments
});
```

### With Callback API

```typescript
// Load migration state
stateStore.load((err, state) => {
  if (err) {
    console.error('Failed to load migration state:', err);
    return;
  }
  console.log('Current migration state:', state);
});

// Save migration state
const migrationState = {
  migrations: [{ title: '1234-my-migration.js', timestamp: Date.now() }],
  lastRun: '1234-my-migration.js',
};

stateStore.save(migrationState, (err) => {
  if (err) {
    console.error('Failed to save migration state:', err);
    return;
  }
  console.log('Migration state saved successfully');
});
```

### With Promise/Async API

```typescript
// Load migration state
try {
  const state = await stateStore.loadAsync();
  console.log('Current migration state:', state);
} catch (err) {
  console.error('Failed to load migration state:', err);
}

// Save migration state
try {
  await stateStore.saveAsync(migrationState);
  console.log('Migration state saved successfully');
} catch (err) {
  console.error('Failed to save migration state:', err);
}
```

### Synchronized Migrations (Cluster Support)

For clustered environments where multiple instances might try to run migrations simultaneously:

```typescript
import { MongoStateStore, synchronizedMigration, synchronizedUp } from '@lenne.tech/nest-server';

const migrationOptions = {
  stateStore: new MongoStateStore({
    uri: 'mongodb://localhost/mydb',
    lockCollectionName: 'migration_lock', // Required for synchronized migrations
  }),
  migrationsDirectory: './migrations',
};

// Custom migration logic
await synchronizedMigration(migrationOptions, async (migrationSet) => {
  // Only one instance at a time will execute this code
  console.log('Running migrations...');
  await promisify(migrationSet.up).call(migrationSet);
});

// Or use the convenience function to run all pending migrations
await synchronizedUp(migrationOptions);
```

## API Reference

### MongoStateStore

#### Constructor

```typescript
new MongoStateStore(options: string | MongoStateStoreOptions)
```

**Parameters:**

- `options`: MongoDB URI string or configuration object
  - `uri`: MongoDB connection URI (required)
  - `collectionName`: Name of the collection to store migration state (default: 'migrations')
  - `lockCollectionName`: Collection name for locking mechanism (optional)

#### Methods

##### load(callback)

Loads the migration state from MongoDB (callback-based).

```typescript
load(fn: (err?: Error, set?: MigrationSet) => void): void
```

##### loadAsync()

Loads the migration state from MongoDB (promise-based).

```typescript
loadAsync(): Promise<MigrationSet>
```

##### save(set, callback)

Saves the migration state to MongoDB (callback-based).

```typescript
save(set: MigrationSet, fn: (err?: Error) => void): void
```

##### saveAsync(set)

Saves the migration state to MongoDB (promise-based).

```typescript
saveAsync(set: MigrationSet): Promise<void>
```

### Helper Functions

#### synchronizedMigration

Wraps migrations with a lock to prevent simultaneous execution in clustered environments.

```typescript
async function synchronizedMigration(
  opts: MigrationOptions,
  callback: (set: MigrationSet) => Promise<void>,
): Promise<void>;
```

#### synchronizedUp

Convenience function that executes all pending migrations in a synchronized manner.

```typescript
async function synchronizedUp(opts: MigrationOptions): Promise<void>;
```

## How It Works

### State Storage

The migration state is stored in a MongoDB collection (default: `migrations`) as a single document containing:

```typescript
{
  migrations: [
    {
      title: 'migration-name.js',
      timestamp: 1234567890,
      description: 'Migration description'
    }
  ],
  lastRun: 'last-migration-name.js'
}
```

### Locking Mechanism

When using `synchronizedMigration` or `synchronizedUp`:

1. A unique index is created on the lock collection
2. The migration process attempts to insert a lock document
3. Only one instance can successfully insert (others wait)
4. After migration completes, the lock is released
5. Waiting instances can then proceed

This ensures that in a cluster with multiple nodes, migrations run on only one machine at a time.

## Examples

### Example: Migration File

Create a migration file in your migrations directory:

```javascript
// migrations/1234567890-add-user-email.js

'use strict';

const { MongoClient } = require('mongodb');
const { promisify } = require('util');
const { callbackify } = require('util');

const mongoUrl = process.env.MONGODB_URL;

module.exports.up = function (next) {
  callbackify(async () => {
    const client = await MongoClient.connect(mongoUrl);
    try {
      await client
        .db()
        .collection('users')
        .updateMany({ email: { $exists: false } }, { $set: { email: '' } });
    } finally {
      await client.close();
    }
  })(next);
};

module.exports.down = function (next) {
  callbackify(async () => {
    const client = await MongoClient.connect(mongoUrl);
    try {
      await client
        .db()
        .collection('users')
        .updateMany({}, { $unset: { email: '' } });
    } finally {
      await client.close();
    }
  })(next);
};
```

### Example: Running Migrations in Your Application

```typescript
import { MongoStateStore, synchronizedUp } from '@lenne.tech/nest-server';
import path from 'path';

async function runMigrations() {
  const migrationOptions = {
    stateStore: new MongoStateStore({
      uri: process.env.MONGODB_URL || 'mongodb://localhost/mydb',
      lockCollectionName: 'migration_lock',
    }),
    migrationsDirectory: path.join(__dirname, 'migrations'),
  };

  try {
    await synchronizedUp(migrationOptions);
    console.log('Migrations completed successfully');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

// Run migrations on application startup
runMigrations().catch(console.error);
```

## Differences from @nodepit/migrate-state-store-mongodb

While maintaining full API compatibility, this implementation offers:

1. **Better TypeScript Support**: Full type definitions and modern TypeScript syntax
2. **MongoDB 7.x Support**: Works with latest MongoDB versions
3. **Async/Await**: Modern async patterns instead of callback-heavy code
4. **Better Error Handling**: More descriptive error messages
5. **No Additional Dependencies**: Uses only what's already in nest-server

## Testing

The module includes a comprehensive test suite with 25+ test cases covering:

- Initialization and configuration
- Error handling
- Loading and saving state
- Callback and Promise APIs
- Locking mechanism
- Parallel execution
- Backward compatibility
- MongoDB 7.x features

Run the tests:

```bash
npm test -- tests/migrate/mongo-state-store.e2e-spec.ts
```

## Migration Utilities

In addition to the state store, this module provides helpful utilities for managing migrations:

### createMigrationStore()

Factory function to create a migration store class for use with the migrate CLI:

```javascript
// migrations-utils/migrate.js
const { createMigrationStore } = require('@lenne.tech/nest-server');
const config = require('../src/config.env');

module.exports = createMigrationStore(
  config.default.mongoose.uri,
  'migrations', // optional collection name
  'migration_lock', // optional lock collection for clusters
);
```

### getDb()

Helper function to get a database connection in your migrations:

```typescript
import { getDb } from '@lenne.tech/nest-server';

const db = await getDb('mongodb://localhost/mydb');
await db.collection('users').updateMany(...);
```

### uploadFileToGridFS()

Helper function to upload files to GridFS during migrations:

```typescript
import { uploadFileToGridFS } from '@lenne.tech/nest-server';

const fileId = await uploadFileToGridFS('mongodb://localhost/mydb', '../assets/image.png', {
  bucketName: 'images',
  filename: 'logo.png',
});
```

### Migration Templates

Ready-to-use template for nest-server projects:

**Project Template**: `dist/core/modules/migrate/templates/migration-project.template.ts`

This template automatically imports `getDb()` and `uploadFileToGridFS()` from nest-server, along with your project's config. It's ready to use with zero configuration.

### TypeScript Compiler

Pre-configured TypeScript compiler for migrate CLI:

```bash
migrate --compiler="ts:./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/helpers/ts-compiler.js"
```

## Complete Setup Guide

For a complete step-by-step guide on migrating from @nodepit/migrate-state-store-mongodb, see [MIGRATION_FROM_NODEPIT.md](./MIGRATION_FROM_NODEPIT.md).

### Quick Setup (No External Dependencies!) 🚀

**No need to install the `migrate` package!** nest-server now includes a built-in migration CLI.

1. Install ts-node (dev dependency): `npm install --save-dev ts-node`
2. Create `migrations-utils/migrate.js` using `createMigrationStore()`
3. Add migration scripts to your `package.json`
4. Run migrations using the built-in CLI

**Example package.json scripts:**

```json
{
  "scripts": {
    "migrate:create": "migrate create --template-file ./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/templates/migration-project.template.ts --migrations-dir ./migrations --compiler ts:./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/helpers/ts-compiler.js",
    "migrate:up": "migrate up --store ./migrations-utils/migrate.js --migrations-dir ./migrations --compiler ts:./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/helpers/ts-compiler.js",
    "migrate:down": "migrate down --store ./migrations-utils/migrate.js --migrations-dir ./migrations --compiler ts:./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/helpers/ts-compiler.js"
  }
}
```

The `migrate` command comes from `@lenne.tech/nest-server` - no external package needed!

See the [Migration Guide](./MIGRATION_FROM_NODEPIT.md) for detailed migration instructions from @nodepit.

## Project Integration

The migration utilities are designed to minimize boilerplate in your projects. Instead of copying multiple utility files, you can:

1. Use `createMigrationStore()` for your store configuration
2. Use the built-in TypeScript compiler
3. Optionally use the provided templates
4. Only maintain project-specific migration files

This significantly reduces the amount of migration-related code in each project.

## License

MIT

## Support

For issues and questions:

- GitHub: https://github.com/lenneTech/nest-server/issues
- Documentation: https://nest-server.lenne.tech