import { createRequire } from 'node:module';
import { join } from 'node:path';

import type * as NestMongoose from '@nestjs/mongoose';
import type * as Mongodb from 'mongodb';
import type * as Mongoose from 'mongoose';

import { callerDirectory } from '../../helpers/module-location.helper.js';

/**
 * MongoDB's libraries — `mongoose`, `@nestjs/mongoose` and `mongodb` — are OPTIONAL peers since 12.1.0: a project that
 * keeps its data in PostgreSQL installs none of them. Every module of the core that needs one at runtime takes it from
 * here instead of importing it, because a static import of a package that is not installed fails the moment the
 * barrel is loaded — long before anything could say which feature wanted it.
 *
 * Loaded synchronously: `@Prop()` and `@Schema()` run while a model class is DEFINED, and a project's own model file
 * calls `SchemaFactory.createForClass()` right after — the decorators of the core's base classes must have reached
 * Mongoose's metadata storage by then. `createRequire()` from this file's location resolves the packages the way a
 * static import of the core would (the package's own peers in npm mode, the project's dependencies in vendor mode),
 * and Node hands `require()` and `import` the same module instance: `mongoose` and `mongodb` are CommonJS, and
 * `@nestjs/mongoose` (ESM only) is loaded through `require(esm)`, which shares the ESM loader's cache.
 *
 * Import-free leaf apart from the location helper — `import type` only — so it can sit below every module that needs
 * it without joining an import cycle.
 */

/** The three packages, when installed */
export interface MongoPackages {
  /** The MongoDB driver: the project's own `mongodb`, else the one Mongoose ships (`mongoose.mongo`) */
  mongodb: typeof Mongodb;
  mongoose: typeof Mongoose;
  nestMongoose: typeof NestMongoose;
}

/** MongoDB support was needed, and its libraries are not installed */
export class MongoPackagesMissingError extends Error {
  override readonly name = 'MongoPackagesMissingError';
}

const PACKAGE_SPECIFIERS = ['mongoose', '@nestjs/mongoose'] as const;

/** Resolves like a static import of this module would */
const requireHere = createRequire(join(callerDirectory(), 'mongo-packages.js'));

/** `undefined` until the first look, `null` when the packages are not installed */
let cached: MongoPackages | null | undefined;

/**
 * The packages when installed, else `undefined`. Throws when only one of `mongoose` / `@nestjs/mongoose` is installed:
 * that is a broken installation, not a choice, and guessing either way would hide it.
 */
export function optionalMongoPackages(): MongoPackages | undefined {
  if (cached === undefined) {
    cached = loadMongoPackages() ?? null;
  }
  return cached ?? undefined;
}

/**
 * The packages, or a named error saying which feature needed them and what to install.
 *
 * @param feature what needs MongoDB, in the words of the configuration ("the `mongoose` configuration", "GridFS")
 */
export function requireMongoPackages(feature: string): MongoPackages {
  const packages = optionalMongoPackages();
  if (!packages) {
    throw new MongoPackagesMissingError(
      `${feature} needs MongoDB, and its libraries are not installed. They are optional peer dependencies of ` +
        '@lenne.tech/nest-server since 12.1.0 — add them to the project: `pnpm add mongoose @nestjs/mongoose mongodb` ' +
        '(the versions in the migration guide 12.0.x → 12.1.x).',
    );
  }
  return packages;
}

/**
 * Better-Auth's MongoDB adapter — imported only where Better-Auth keeps its data in MongoDB, because it loads the
 * MongoDB driver as it is evaluated
 */
export function requireBetterAuthMongoAdapter(): (db: unknown) => unknown {
  requireMongoPackages('Better-Auth on MongoDB (the user model is not routed to a SQL source)');
  return (requireHere('better-auth/adapters/mongodb') as { mongodbAdapter: (db: unknown) => unknown }).mongodbAdapter;
}

/** Whether MongoDB's libraries are installed */
export function hasMongoPackages(): boolean {
  return !!optionalMongoPackages();
}

function loadMongoPackages(): MongoPackages | undefined {
  const [mongoose, nestMongoose] = PACKAGE_SPECIFIERS.map((specifier) => optionalRequire(specifier));
  if (!mongoose && !nestMongoose) {
    return undefined;
  }
  if (!mongoose || !nestMongoose) {
    const missing = mongoose ? '@nestjs/mongoose' : 'mongoose';
    throw new MongoPackagesMissingError(
      `MongoDB support needs both mongoose and @nestjs/mongoose; ${missing} is not installed. Install it, or remove ` +
        'the other one if the project keeps no data in MongoDB.',
    );
  }
  const mongodb = optionalRequire('mongodb') ?? (mongoose as typeof Mongoose).mongo;
  return {
    mongodb: mongodb as typeof Mongodb,
    mongoose: mongoose as typeof Mongoose,
    nestMongoose: nestMongoose as typeof NestMongoose,
  };
}

/** The package, or `undefined` when it is not installed — any other loading error is a real one and propagates */
function optionalRequire(specifier: string): unknown {
  try {
    return requireHere(specifier);
  } catch (error) {
    if (isNotInstalled(error, specifier)) {
      return undefined;
    }
    throw error;
  }
}

/** A "module not found" for the package itself — not for something the package failed to load */
function isNotInstalled(error: unknown, specifier: string): boolean {
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  return (
    (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') &&
    typeof message === 'string' &&
    (message.includes(`'${specifier}'`) || message.includes(`"${specifier}"`))
  );
}
