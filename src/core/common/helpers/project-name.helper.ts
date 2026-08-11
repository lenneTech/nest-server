import * as fs from 'fs';
import * as path from 'path';

/**
 * Cached slug for the current process — package.json is read at most once.
 *
 * `undefined` means "not read yet"; a string (including the fallback) means "read".
 */
let cachedProjectSlug: string | undefined;

/** Used when package.json is unreadable or carries no usable name */
const FALLBACK_SLUG = 'nest-server';

/**
 * The project's package name, reduced to a form that is safe as a key namespace.
 *
 * This exists so framework-managed keys in SHARED infrastructure (Redis today) are namespaced per
 * application instead of per framework. A constant default is fine until two applications point at
 * one Redis — a normal staging setup — at which point identically-named cron jobs, rate-limit
 * counters and diagnostic buffers of different applications land on the same keys. That failure is
 * silent: one app's scheduler consumes the other's jobs, and the job simply never runs where it was
 * defined.
 *
 * Deliberately NOT the display name from `getProjectAppName()` in the better-auth config: that one
 * is Title Case with an environment suffix ("My App (Local)"), which is right for a 2FA issuer and
 * wrong for a key prefix.
 *
 * @returns lower-case slug, scope stripped (`@acme/api` → `acme-api`), or `nest-server` as fallback
 */
export function getProjectSlug(): string {
  if (cachedProjectSlug !== undefined) {
    return cachedProjectSlug;
  }

  cachedProjectSlug = FALLBACK_SLUG;

  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    if (raw?.name && typeof raw.name === 'string') {
      const slug = slugify(raw.name);
      if (slug) {
        cachedProjectSlug = slug;
      }
    }
  } catch {
    // Unreadable package.json is not worth failing a boot over — the fallback keeps the previous
    // behavior, which is exactly what a consumer without a readable manifest had before.
  }

  return cachedProjectSlug;
}

/** Reset the cache — tests only, so a fixture can vary the detected name */
export function resetProjectSlugCache(): void {
  cachedProjectSlug = undefined;
}

/**
 * Reduce a package name to a key-safe slug.
 *
 * Colons are stripped rather than replaced because the framework uses `:` as its own key separator —
 * a name containing one would otherwise invent a namespace level.
 */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
