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

/** Default environment variable the build commit SHA is baked into. */
export const DEFAULT_COMMIT_ENV = 'APP_VERSION_COMMIT';

/** Defined value returned when no commit could be resolved. */
export const UNKNOWN_COMMIT = 'unknown';

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
    version: options.version || UNKNOWN_COMMIT,
  };
}
