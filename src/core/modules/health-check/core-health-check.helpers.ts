import { Logger } from '@nestjs/common';

import type { IServerOptions } from '../../common/interfaces/server-options.interface.js';

/** The checks `healthCheck.configs` configures, in the order they report */
export const CORE_HEALTH_CHECK_NAMES = ['database', 'memoryHeap', 'memoryRss', 'storage', 'build'] as const;

/** A check `healthCheck.configs` configures */
export type CoreHealthCheckName = (typeof CORE_HEALTH_CHECK_NAMES)[number];

/** Which endpoint a health check answers for: `GET /health-check` (liveness) or `GET /health-check/ready` (readiness) */
export type CoreHealthCheckKind = 'liveness' | 'readiness';

/** The checks the readiness endpoint runs without `healthCheck.readiness.checks` */
export const DEFAULT_READINESS_CHECKS: readonly CoreHealthCheckName[] = ['database', 'build'];

/** The readiness endpoint as the configuration describes it */
export interface IResolvedHealthCheckReadiness {
  /** The configured checks the readiness endpoint runs, in report order */
  checks: CoreHealthCheckName[];
  /** Whether `GET /health-check/ready` is registered */
  enabled: boolean;
}

const logger = new Logger('CoreHealthCheck');
const warnedUnknownChecks = new Set<string>();

/**
 * Resolve `healthCheck.readiness` (12.11.0): boolean shorthand and "presence implies enabled".
 *
 * - absent (or `false`, `{ enabled: false }`): no readiness endpoint — the health check is what it was
 * - `true` / `{}`: `GET /health-check/ready` with the default checks (`database`, `build`)
 * - `{ checks: [...] }`: the listed checks of `healthCheck.configs` — a list (or a comma-separated string, which is
 *   what an `NSC__HEALTH_CHECK__READINESS__CHECKS` variable gives) of `database`, `memoryHeap`, `memoryRss`, `storage`,
 *   `build`. Unknown names are ignored with one warning each; `[]` runs only the project's own readiness indicators.
 *
 * A listed check runs in the readiness check whatever `configs.<check>.enabled` says: that flag decides for
 * `GET /health-check`. Key, thresholds and options come from `configs.<check>`.
 */
export function resolveHealthCheckReadiness(healthCheck: IServerOptions['healthCheck']): IResolvedHealthCheckReadiness {
  const readiness = healthCheck?.readiness;
  const enabled = readiness === true || (!!readiness && typeof readiness === 'object' && readiness.enabled !== false);
  if (!enabled || typeof readiness !== 'object' || readiness.checks === undefined || readiness.checks === null) {
    return { checks: enabled ? [...DEFAULT_READINESS_CHECKS] : [], enabled };
  }
  const listed = typeof readiness.checks === 'string' ? readiness.checks.split(',') : readiness.checks;
  if (!Array.isArray(listed)) {
    warnOnce(`healthCheck.readiness.checks is neither a list nor a string — the default checks run`);
    return { checks: [...DEFAULT_READINESS_CHECKS], enabled };
  }
  const names = listed.map((name) => (typeof name === 'string' ? name.trim() : name)).filter((name) => name !== '');
  for (const name of names) {
    if (!(CORE_HEALTH_CHECK_NAMES as readonly unknown[]).includes(name)) {
      warnOnce(`healthCheck.readiness.checks names an unknown check "${String(name)}" — it is ignored`);
    }
  }
  return { checks: CORE_HEALTH_CHECK_NAMES.filter((name) => names.includes(name)), enabled };
}

function warnOnce(message: string): void {
  if (!warnedUnknownChecks.has(message)) {
    warnedUnknownChecks.add(message);
    logger.warn(message);
  }
}
