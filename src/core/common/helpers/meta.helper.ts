/**
 * Build identity helpers.
 *
 * A deployed image's exact build is identified by its git commit SHA, baked in
 * at build time via an environment variable (default `APP_VERSION_COMMIT`, fed
 * from the CI commit SHA — the same value typically used as the image tag).
 *
 * Unlike the semantic `version` (a rarely-bumped semver that may legitimately
 * differ between an API and its frontend, since each is versioned independently)
 * the commit SHA uniquely pins the exact running build. A frontend and backend
 * deployed together bake the SAME commit, but each reads its own at runtime — so
 * comparing them detects a drifted / stale container after a partial rollout.
 *
 * @see getCommit
 * @see getBuildInfo
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** Default environment variable the build commit SHA is baked into. */
export const DEFAULT_COMMIT_ENV = 'APP_VERSION_COMMIT';

/** Defined value returned when no commit could be resolved. */
export const UNKNOWN_COMMIT = 'unknown';

/** Cached package.json version lookup (`null` = looked up and not found). */
let cachedVersion: null | string | undefined;

/**
 * Build identity of the running process.
 */
export interface BuildInfo {
  /** Git commit SHA the build was produced from, or `'unknown'`. */
  commit: string;

  /** Environment the process runs in (e.g. `'production'`), if provided. */
  env?: string;

  /** Semantic version of the build, or `'unknown'`. */
  version?: string;
}

/**
 * Resolve the git commit SHA the running build was produced from.
 *
 * Reads `process.env[envName]` (default `APP_VERSION_COMMIT`). Falls back to
 * `'unknown'` so local / un-tagged builds still return a defined value — clients
 * use `'unknown'` to suppress the "builds drifted" warning instead of comparing
 * against an empty string.
 *
 * @param envName Name of the environment variable holding the commit SHA.
 */
export function getCommit(envName: string = DEFAULT_COMMIT_ENV): string {
  return process.env[envName] || UNKNOWN_COMMIT;
}

/**
 * Assemble the build identity of the running process.
 *
 * Combines the commit SHA (from the environment) with an optionally supplied
 * `version` and `env`. Designed to be surfaced via a public meta / info endpoint
 * and the health check so deployments can be compared at a glance.
 *
 * @param options.commitEnvName Override the env var the commit SHA is read from.
 * @param options.env Environment label to include (e.g. from the config).
 * @param options.version Semantic version to include (e.g. from package.json).
 */
export function getBuildInfo(options: { commitEnvName?: string; env?: string; version?: string } = {}): BuildInfo {
  return {
    commit: getCommit(options.commitEnvName),
    env: options.env,
    version: options.version || getVersion(),
  };
}

/**
 * Resolve the semantic version of the running app from its `package.json`.
 *
 * Reads the `version` field of the nearest `package.json` (searching up from the current working
 * directory), cached after the first lookup. This is the deployed app's own version — in a consumer
 * project that is the API's version, in this repo it is the framework version. Falls back to
 * `'unknown'` when no `package.json` / version can be resolved.
 *
 * Prefer an explicit `IServerOptions.version` when set; this is the zero-config default.
 */
export function getVersion(): string {
  if (cachedVersion !== undefined) {
    return cachedVersion ?? UNKNOWN_COMMIT;
  }
  cachedVersion = null;
  try {
    // Walk up from cwd so a monorepo `projects/api` started from the repo root still resolves.
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const pkgPath = join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
        if (typeof pkg.version === 'string' && pkg.version) {
          cachedVersion = pkg.version;
          break;
        }
      }
      const parent = join(dir, '..');
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  } catch {
    /* ignore — fall back to 'unknown' */
  }
  return cachedVersion ?? UNKNOWN_COMMIT;
}
