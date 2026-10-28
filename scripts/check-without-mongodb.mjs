#!/usr/bin/env node
/**
 * Proves that a project on PostgreSQL alone needs none of MongoDB's libraries (12.1.0+: `mongoose`,
 * `@nestjs/mongoose` and `mongodb` are optional peers). Boots `scripts/lib/without-mongodb.app.mjs` on a PostgreSQL
 * database of this run's own and requires the framework to load, boot, run CRUD through a data store, sign a user up
 * and in through Better-Auth and store a file without GridFS.
 *
 *   node scripts/check-without-mongodb.mjs             the source, the packages HIDDEN (seconds; catches a static
 *                                                      import the moment it is written)
 *   node scripts/check-without-mongodb.mjs --dist      the build, the packages hidden (part of `check`)
 *   node scripts/check-without-mongodb.mjs --package   the packed tarball installed with npm into a fresh project that
 *                                                      does not declare them — they are NOT INSTALLED, and the run
 *                                                      fails if any of them reaches node_modules (publish path)
 *
 * "Hidden" means `scripts/lib/without-mongodb.hooks.mjs` makes them unresolvable for `import`, `require()` and
 * `createRequire()` alike. Needs the test PostgreSQL (`pnpm run test:infra`; CI starts it itself, LT_TEST_INFRA=0).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { Client } = require('pg');

const mode = process.argv.includes('--package') ? 'package' : process.argv.includes('--dist') ? 'dist' : 'source';
const MONGO_PACKAGES = ['mongoose', '@nestjs/mongoose', 'mongodb'];
const log = (text) => console.log(`[without-mongodb] ${text}`);

const host = process.env.PG_HOST || '127.0.0.1';
const port = Number(process.env.PG_PORT || 5440);
const owner = {
  password: process.env.PG_OWNER_PASSWORD || 'nest-owner-secret',
  user: process.env.PG_OWNER_USER || 'nest_owner',
};
const appRole = {
  password: process.env.PG_APP_PASSWORD || 'nest-app-secret',
  user: process.env.PG_APP_USER || 'nest_app',
};
const url = (role, database) =>
  `postgres://${encodeURIComponent(role.user)}:${encodeURIComponent(role.password)}@${host}:${port}/${database}`;

if (process.env.LT_TEST_INFRA !== '0') {
  const infra = spawnSync(process.execPath, [join(root, 'scripts/test-infra.mjs'), 'up'], { stdio: 'inherit' });
  if (infra.status !== 0) {
    process.exit(infra.status ?? 1);
  }
}

/** Where the app runs, what it imports, and how Node is started for it */
function prepare() {
  if (mode === 'source' || mode === 'dist') {
    const entry = mode === 'dist' ? join(root, 'dist/index.js') : join(root, 'src/index.ts');
    if (!existsSync(entry)) {
      log(`${entry} does not exist${mode === 'dist' ? ' — run `pnpm run build` first' : ''}`);
      process.exit(1);
    }
    return {
      app: join(root, 'scripts/lib/without-mongodb.app.mjs'),
      cleanup: () => undefined,
      config: mode === 'dist' ? join(root, 'dist/config.env.js') : join(root, 'src/config.env.ts'),
      cwd: root,
      entry,
      nodeArgs: [
        '--import',
        join(root, 'scripts/lib/without-mongodb.hooks.mjs'),
        ...(mode === 'source' ? ['-r', join(root, 'src/core/modules/migrate/helpers/ts-compiler.js')] : []),
      ],
    };
  }

  // --package: a project that declares the framework, PostgreSQL and the framework's required peers — nothing else
  const project = mkdtempSync(join(tmpdir(), 'nest-server-without-mongodb-'));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  log(`packing ${manifest.name}@${manifest.version}`);
  const packed = execFileSync('pnpm', ['pack', '--pack-destination', project], { cwd: root, encoding: 'utf8' })
    .trim()
    .split('\n')
    .pop();
  const required = Object.keys(manifest.peerDependencies).filter(
    (name) => !manifest.peerDependenciesMeta?.[name]?.optional,
  );
  const dependencies = {
    [manifest.name]: `file:${packed}`,
    pg: manifest.devDependencies.pg,
    typeorm: manifest.devDependencies.typeorm,
  };
  for (const name of required) {
    dependencies[name] = manifest.devDependencies[name];
  }
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ dependencies, name: 'postgres-only-project', private: true, version: '1.0.0' }, null, 2),
  );
  log(`installing into ${project} (${Object.keys(dependencies).join(', ')})`);
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: project, stdio: 'inherit' });

  const installed = findPackages(join(project, 'node_modules'), MONGO_PACKAGES);
  if (installed.length) {
    log(`FAILED: MongoDB libraries were installed: ${installed.join(', ')}`);
    process.exit(1);
  }
  log(`installed without ${MONGO_PACKAGES.join(', ')}`);

  copyFileSync(join(root, 'scripts/lib/without-mongodb.app.mjs'), join(project, 'app.mjs'));
  const framework = join(project, 'node_modules', ...manifest.name.split('/'));
  return {
    app: join(project, 'app.mjs'),
    cleanup: () => rmSync(project, { force: true, recursive: true }),
    config: join(framework, 'dist/config.env.js'),
    cwd: project,
    entry: join(framework, 'dist/index.js'),
    nodeArgs: [],
  };
}

/** Every directory under node_modules that is one of the named packages, at any depth */
function findPackages(directory, names) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 8 || !existsSync(dir)) {
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.name.startsWith('@')) {
        for (const scoped of readdirSync(path, { withFileTypes: true })) {
          if (scoped.isDirectory()) {
            const name = `${entry.name}/${scoped.name}`;
            if (names.includes(name)) {
              found.push(join(path, scoped.name));
            }
            walk(join(path, scoped.name, 'node_modules'), depth + 1);
          }
        }
      } else if (entry.name !== '.bin' && entry.name !== '.cache') {
        if (names.includes(entry.name)) {
          found.push(path);
        }
        walk(join(path, 'node_modules'), depth + 1);
      }
    }
  };
  walk(directory, 0);
  return found;
}

// `ci` as a whole segment: the name passes the test-database drop guard
const database = `nest_server_ci_without_mongodb_${process.pid}`;
const admin = async (statement) => {
  const client = new Client({ connectionString: url(owner, 'nest_server_e2e') });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
};

const run = prepare();
await admin(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
await admin(`CREATE DATABASE "${database}" OWNER "${owner.user}"`);
await admin(`GRANT CONNECT ON DATABASE "${database}" TO "${appRole.user}"`);
let status = 1;
try {
  const result = spawnSync(process.execPath, [...run.nodeArgs, run.app], {
    cwd: run.cwd,
    env: {
      ...process.env,
      FRAMEWORK_CONFIG: pathToFileURL(run.config).href,
      FRAMEWORK_ENTRY: pathToFileURL(run.entry).href,
      NODE_ENV: 'ci',
      NSC__DATABASE__OWNER_URL: '',
      NSC__DATABASE__URL: '',
      NSC__MONGOOSE__URI: '',
      PROOF_DATABASE_OWNER_URL: url(owner, database),
      PROOF_DATABASE_URL: url(appRole, database),
    },
    stdio: 'inherit',
    timeout: 180_000,
  });
  status = result.status ?? 1;
} finally {
  await admin(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  run.cleanup();
}
log(status === 0 ? `ok (${mode})` : `failed (exit ${status}, ${mode})`);
process.exit(status);
