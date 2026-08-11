import { Logger } from '@nestjs/common';

import { IServerOptions } from '../../common/interfaces/server-options.interface';

const logger = new Logger('CoreFileStorage');

/**
 * The three storage drivers. All equivalent in what they offer through
 * `CoreFileService`; they differ only in where the bytes end up.
 *
 * - `'s3'`         — an S3-compatible bucket. The only one that survives horizontal scaling.
 * - `'gridfs'`     — MongoDB GridFS. No extra infrastructure, bytes share the database.
 * - `'filesystem'` — the local disk. Pod-local: not shared between replicas, lost on restart
 *                    unless the path is a mounted volume.
 */
export type FileStorageDriver = 'filesystem' | 'gridfs' | 's3';

export const FILE_STORAGE_DRIVERS: FileStorageDriver[] = ['filesystem', 'gridfs', 's3'];

/**
 * How a driver was arrived at — for the boot log and for error messages, so a
 * surprising choice can be traced back to the setting that produced it.
 */
export interface FileStorageResolution {
  driver: FileStorageDriver;
  explicit: boolean;
  reason: string;
}

/**
 * Whether the S3 configuration names a concrete bucket to write to.
 *
 * A bucket is the one thing S3 cannot default: region, endpoint and credentials
 * all have fallbacks (the AWS default credential chain resolves an IAM role,
 * an instance profile or `AWS_*` environment variables without anything in the
 * config), but "which bucket" has to be stated. So the presence of a bucket is
 * what makes an S3 configuration usable — and therefore what makes S3 eligible
 * as the automatic default.
 */
export function hasUsableS3Config(config?: Partial<IServerOptions>): boolean {
  const s3 = config?.s3;
  if (!s3 || typeof s3 !== 'object' || (s3 as { enabled?: boolean }).enabled === false) {
    return false;
  }
  return !!(s3 as { bucket?: string }).bucket;
}

/**
 * Whether a database connection is configured.
 *
 * Note "configured", not "reachable": an unreachable but configured database is
 * an ERROR, never a reason to quietly store files somewhere else. Mongoose fails
 * the boot on its own in that case, which is the behaviour we want — silently
 * degrading to the local disk would scatter a project's files across two stores
 * during an outage and leave no trace of which file went where.
 */
export function hasDatabaseConfig(config?: Partial<IServerOptions>): boolean {
  return !!config?.mongoose?.uri;
}

/**
 * Decide which storage driver to use.
 *
 * An EXPLICIT `file.storage` always wins and is never second-guessed here —
 * whether the chosen store is actually reachable is asserted separately, at
 * boot, by `assertFileStorageAvailable()`. That split matters: this function
 * answers "what did the project ask for", not "did it work".
 *
 * Without an explicit value the default is derived, most capable first:
 *
 *   1. `s3`         — when the S3 config names a bucket
 *   2. `gridfs`     — when a database is configured
 *   3. `filesystem` — when neither is (today a theoretical case: `CoreModule`
 *                     always registers Mongoose, so a project without a database
 *                     does not boot at all)
 *
 * @param config the merged server configuration
 */
export function resolveFileStorage(config?: Partial<IServerOptions>): FileStorageResolution {
  const configured = config?.file?.storage;

  if (configured !== undefined) {
    if (!FILE_STORAGE_DRIVERS.includes(configured as FileStorageDriver)) {
      throw new Error(
        `Invalid file.storage: ${JSON.stringify(configured)}. ` +
          `Expected one of ${FILE_STORAGE_DRIVERS.map((d) => `'${d}'`).join(', ')}.`,
      );
    }
    return {
      driver: configured as FileStorageDriver,
      explicit: true,
      reason: `file.storage is set to '${configured}'`,
    };
  }

  if (hasUsableS3Config(config)) {
    return { driver: 's3', explicit: false, reason: 's3.bucket is configured' };
  }

  if (hasDatabaseConfig(config)) {
    return { driver: 'gridfs', explicit: false, reason: 'a database is configured and no S3 bucket is' };
  }

  return {
    driver: 'filesystem',
    explicit: false,
    reason: 'neither an S3 bucket nor a database is configured',
  };
}

/**
 * Fail the boot when the resolved driver cannot actually be used.
 *
 * This is the deliberate opposite of the previous behaviour, which silently fell
 * back to GridFS whenever S3 was selected but unavailable. That failure mode is
 * the worst kind: the application keeps working, so nothing looks broken, while
 * files land in a store the operator does not believe they are in — and no
 * migration path exists afterwards, because nobody knows which file went where.
 *
 * A misconfiguration should stop the process at boot, where it is cheap.
 *
 * Both an explicit and a derived choice are enforced — only the message differs.
 * A derived one is not automatically safe: `s3.bucket` in the config makes S3
 * the default, but the bytes still go nowhere unless the project's own
 * `FileService` forwards `s3Service` to `super()`.
 *
 * @param resolution result of `resolveFileStorage()`
 * @param available  whether the driver's backing service reports itself usable
 */
export function assertFileStorageAvailable(resolution: FileStorageResolution, available: boolean): void {
  if (available) {
    return;
  }

  if (!resolution.explicit) {
    // A derived driver can still be unusable — the commonest case being an `s3`
    // block that names a bucket while the project's own FileService never
    // forwards `s3Service` to `super()`, so the driver has nothing to write
    // through. Failing here is the point: the alternative is files silently
    // landing in GridFS while the operator reads the config and believes S3.
    throw new Error(
      `File storage '${resolution.driver}' was selected automatically (${resolution.reason}) but is not available. ` +
        'Either make it available (for S3: forward `{ configService, s3Service }` to `super()` in your FileService ' +
        'and install `@aws-sdk/client-s3`), or pin a different driver with `file.storage`.',
    );
  }

  const hint =
    resolution.driver === 's3'
      ? 'Configure `s3` (bucket, credentials/endpoint) and install `@aws-sdk/client-s3`, or choose a different `file.storage`.'
      : `Check the configuration for the '${resolution.driver}' driver, or choose a different \`file.storage\`.`;

  throw new Error(`file.storage is set to '${resolution.driver}', but that storage is not available. ${hint}`);
}

/**
 * Log the resolved driver once, so the store in use is visible in the boot log
 * rather than having to be inferred from where files stop appearing.
 */
export function logFileStorage(resolution: FileStorageResolution): void {
  const how = resolution.explicit ? 'configured' : 'defaulted';
  logger.log(`File storage: ${resolution.driver} (${how} — ${resolution.reason})`);
}
