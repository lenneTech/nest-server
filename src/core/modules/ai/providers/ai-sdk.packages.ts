import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * The optional AI SDK and NestJS AI packages, loaded lazily and checked against the versions this release was tested
 * with (nestjs-ai plan §2, principle 2).
 *
 * `ai`, `@nestjs/ai` and `@nestjs/resilience` are OPTIONAL peers: a project that does not install them loads nothing
 * here. A project that does gets a loud error naming the package and the tested range when the installed version lies
 * outside it, or when the members the framework calls are missing — never a quiet misbehaviour of a 0.0.x release.
 * Each check runs once per process.
 */

/** The version ranges each package was tested with: `[lowest inclusive, highest exclusive]`. */
export const AI_SDK_TESTED_RANGES = {
  '@nestjs/ai': ['0.0.2', '0.0.3'],
  '@nestjs/resilience': ['0.0.3', '0.0.4'],
  ai: ['7.0.0', '8.0.0'],
} as const satisfies Record<string, readonly [string, string]>;

export type AiSdkPackageName = keyof typeof AI_SDK_TESTED_RANGES;

/** A package is missing, outside its tested range, or lacks a member the framework calls. */
export class AiSdkPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiSdkPackageError';
  }
}

const checked = new Map<AiSdkPackageName, Promise<any>>();

/** The tested range of a package, as people read it (`>=0.0.2 <0.0.3`). */
export function aiSdkTestedRange(name: AiSdkPackageName): string {
  const [low, high] = AI_SDK_TESTED_RANGES[name];
  return `>=${low} <${high}`;
}

/**
 * Compares two release versions numerically. A pre-release (`1.2.3-beta.1`) compares as lower than its release, so
 * `7.0.0-beta` is outside `>=7.0.0` — a pre-release was not tested.
 */
export function compareReleaseVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core, pre] = value.split('-', 2);
    return { parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre: pre !== undefined };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return left.pre === right.pre ? 0 : left.pre ? -1 : 1;
}

/** Whether `version` lies in the tested range of `name`. */
export function isTestedAiSdkVersion(name: AiSdkPackageName, version: string): boolean {
  const [low, high] = AI_SDK_TESTED_RANGES[name];
  return compareReleaseVersions(version, low) >= 0 && compareReleaseVersions(version, high) < 0;
}

/**
 * The installed version of a package, resolved from the project (`process.cwd()`), the way the framework loads project
 * files (`.claude/rules/architecture.md` → Module Format). `undefined` when its `package.json` cannot be read — the
 * member check below still runs then.
 */
function installedVersion(name: AiSdkPackageName): string | undefined {
  try {
    const requireFromProject = createRequire(join(process.cwd(), 'package.json'));
    return requireFromProject(`${name}/package.json`)?.version;
  } catch {
    return undefined;
  }
}

/** The members of each package the framework calls; a release without them is refused. */
const REQUIRED_MEMBERS: Record<AiSdkPackageName, (module: any) => string[]> = {
  '@nestjs/ai': (module) => [
    typeof module.AiModels?.prototype?.get === 'function' ? '' : 'AiModels.get()',
    typeof module.AiTools?.prototype?.call === 'function' ? '' : 'AiTools.call()',
    'tools' in (module.AiTools?.prototype ?? {}) ? '' : 'AiTools.tools',
  ],
  '@nestjs/resilience': (module) => [
    typeof module.ResiliencePolicy?.wrap === 'function' ? '' : 'ResiliencePolicy.wrap()',
    typeof module.RetryPolicy === 'function' ? '' : 'RetryPolicy',
    typeof module.TimeoutPolicy === 'function' ? '' : 'TimeoutPolicy',
  ],
  ai: (module) => [
    typeof module.generateText === 'function' ? '' : 'generateText()',
    typeof module.jsonSchema === 'function' ? '' : 'jsonSchema()',
  ],
};

/**
 * Checks a loaded package: tested version range and the members the framework calls. Exported for the tests; the
 * loaders below call it once per package.
 */
export function assertAiSdkPackage(name: AiSdkPackageName, module: unknown, version: string | undefined): void {
  if (version !== undefined && !isTestedAiSdkVersion(name, version)) {
    throw new AiSdkPackageError(
      `${name}@${version} is installed, but @lenne.tech/nest-server was tested with ${name} ${aiSdkTestedRange(name)}. ` +
        `Install a version in that range, or update @lenne.tech/nest-server. The framework refuses to run an untested ` +
        `release of a 0.x package rather than misbehave with it.`,
    );
  }
  const missing = REQUIRED_MEMBERS[name](module).filter(Boolean);
  if (missing.length) {
    throw new AiSdkPackageError(
      `${name}${version ? `@${version}` : ''} lacks ${missing.join(', ')}, which @lenne.tech/nest-server calls. ` +
        `Tested range: ${name} ${aiSdkTestedRange(name)}.`,
    );
  }
}

async function load(name: AiSdkPackageName, importer: () => Promise<unknown>, feature: string): Promise<any> {
  let pending = checked.get(name);
  if (!pending) {
    pending = importer().then(
      (module) => {
        assertAiSdkPackage(name, module, installedVersion(name));
        return module;
      },
      (error: unknown) => {
        throw new AiSdkPackageError(
          `${feature} needs the package "${name}" (tested range ${aiSdkTestedRange(name)}), which could not be loaded: ` +
            `${(error as Error)?.message ?? error}. Install it in the project.`,
        );
      },
    );
    // A failure is not cached: the next attempt (after the project installed the package) tries again
    pending.catch(() => checked.delete(name));
    checked.set(name, pending);
  }
  return pending;
}

/** The AI SDK (`ai`). `feature` names what needs it, in configuration words, for the error message. */
export function loadAiSdk(feature: string): Promise<any> {
  return load('ai', () => import('ai'), feature);
}

/** `@nestjs/ai`. */
export function loadNestjsAi(feature: string): Promise<any> {
  return load('@nestjs/ai', () => import('@nestjs/ai'), feature);
}

/** `@nestjs/resilience` (a required peer of `@nestjs/ai`). */
export function loadNestjsResilience(feature: string): Promise<any> {
  return load('@nestjs/resilience', () => import('@nestjs/resilience'), feature);
}
