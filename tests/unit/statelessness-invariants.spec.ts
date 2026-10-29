/**
 * Unit Tests: statelessness invariants
 *
 * The framework may run with more than one replica. Every piece of state a process keeps in
 * memory is therefore a decision — either it is shared (so both replicas agree), or it is
 * deliberately local (and someone has thought about what a second replica does to it).
 *
 * What makes that decision decay is not malice, it is ordinary work: a `new Map()` added to a
 * service is invisible in review, behaves perfectly on one replica, and only misbehaves in
 * production under a load balancer. So this file keeps an INVENTORY. Every process-local state
 * holder in `src/core` is listed with its classification and the reason. The test fails when the
 * code and the inventory disagree — in either direction:
 *
 *   - a NEW holder appears that nobody classified  → the reviewer is forced to answer
 *     "what does a second replica do to this?" before it can merge
 *   - a listed holder DISAPPEARS                    → the stale entry is removed, so the
 *     inventory never rots into a list of things that no longer exist
 *
 * What it can catch: state that syntactically looks like state (a collection held on an object,
 * a repeating timer). What it CANNOT catch: state hidden behind a helper, a module-level `let`
 * mutated at runtime, or state kept in a library the framework merely configures. It is a
 * tripwire on the common shape, not a proof — which is exactly why the classification is written
 * down rather than inferred.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const CORE_DIR = path.join(__dirname, '..', '..', 'src', 'core');

/**
 * How a piece of process-local state behaves with more than one replica.
 *
 * - `shared`  the state itself lives in Redis when it is configured; the in-memory copy is a
 *             fallback with a known, documented degradation
 * - `derived` recomputed from code, config or the database on every replica, so two replicas
 *             cannot disagree in a way that matters
 * - `bounded` genuinely local and genuinely divergent, but only within a stated bound (a TTL,
 *             a request, a connection). The bound is the reason it is acceptable
 * - `local`   local by necessity — it holds something that cannot leave the process at all
 *             (an open socket, a live transport, a callback)
 */
type Classification = 'bounded' | 'derived' | 'local' | 'shared';

interface StateEntry {
  /** Why this classification is the right one — the part a future reader actually needs */
  because: string;
  classification: Classification;
  /** Path relative to src/core */
  file: string;
  /** The declared name, matched against the source line */
  name: string;
}

/**
 * The inventory. Sorted by file; keep it that way.
 */
const INVENTORY: StateEntry[] = [
  {
    because:
      'Connection ids whose capability detection just threw, mapped to the timestamp after '
      + 'which they may be probed again. Genuinely divergent across replicas and deliberately '
      + 'so: the bound is the 5-minute TTL, entries expire on their own and are swept on write, '
      + 'and nothing is persisted either way. A second replica re-probing once is exactly the '
      + 'intended cost — the alternative, sharing it, would let one replica suppress detection '
      + 'for an endpoint the others can reach.',
    classification: 'bounded',
    file: 'modules/ai/services/core-ai.service.ts',
    name: 'detectionBackoff',
  },
  {
    because:
      'The SSE keep-alive timer for ONE in-flight response. It closes over that response '
      + 'socket, so it cannot leave the process by definition, and it lives and dies with the '
      + 'request — cleared in the `finally` of the handler that created it, and `unref`ed so it '
      + 'never holds the event loop open. A second replica serving a different stream has its '
      + 'own, and the two have nothing to agree about.',
    classification: 'local',
    file: 'modules/ai/core-ai.controller.ts',
    name: 'heartbeat',
  },
  {
    because:
      'Reflection metadata keyed by class, derived from decorators at first use. Two replicas '
      + 'compute the identical map from the identical code.',
    classification: 'derived',
    file: 'common/decorators/restricted.decorator.ts',
    name: 'classCache',
  },
  {
    because:
      'When this replica last wrote lastUsedAt for a token, so a busy token costs one write per '
      + 'minute instead of one per request. Genuinely divergent across replicas and harmless: '
      + 'each replica throttles only its own writes, so N replicas write at most N times a minute '
      + 'and lastUsedAt stays accurate to that minute. It is an audit hint, never an '
      + 'authorization input, and the map is capped (cleared at 5000 entries).',
    classification: 'bounded',
    file: 'modules/api-token/core-api-token.service.ts',
    name: 'lastUsedWrites',
  },
  {
    because:
      'Compiled EJS templates keyed by resolved absolute path. Template files ship with the '
      + 'image and do not change at runtime, so every replica compiles the identical function '
      + 'from the identical file. Nothing user-specific is retained — the data is passed per '
      + 'render.',
    classification: 'derived',
    file: 'modules/better-auth/core-better-auth-email-verification.service.ts',
    name: 'compiledTemplates',
  },
  {
    because:
      'Memoised template-path lookups keyed by `<name>:<locale>`. Resolution reads the same '
      + 'filesystem layout on every replica, so two replicas cannot disagree; the map only '
      + 'avoids repeating four blocking existsSync calls per outgoing auth mail.',
    classification: 'derived',
    file: 'modules/better-auth/core-better-auth-email-verification.service.ts',
    name: 'resolvedTemplatePaths',
  },
  {
    because:
      'One connection pool per configured SQL source, opened as the application role. It holds live sockets, so it '
      + 'cannot leave the process; every replica opens its own pool against the same database, and nothing the '
      + 'replicas must agree on lives in it — tenant scope is written per transaction, schema state is in the catalog.',
    classification: 'local',
    file: 'common/persistence/data-source.runtime.ts',
    name: 'executors',
  },
  {
    because:
      'The owner connection per SQL source that migrates the schema while the stores are created; released once the '
      + 'application is bootstrapped. Live sockets, so local; every replica migrates under the same advisory lock, '
      + 'and the schema state it writes lives in the catalog, not here.',
    classification: 'local',
    file: 'common/persistence/data-source.runtime.ts',
    name: 'owners',
  },
  {
    because:
      'The SQL dialect per source (PostgreSQL or MySQL / MariaDB), chosen from the URL scheme of the configuration. '
      + 'Every replica derives the same dialect from the same configuration; the only thing it caches is the '
      + "application account's name as the server reports it, which is the same for every replica.",
    classification: 'derived',
    file: 'common/persistence/data-source.runtime.ts',
    name: 'dialects',
  },
  {
    because:
      'Which MySQL / MariaDB sources this process has already warned about (no row-level security). A boot log '
      + 'line, once per process: every replica warns once for itself, which is what a log reader of that replica '
      + 'needs. Nothing decides on it.',
    classification: 'bounded',
    file: 'common/persistence/data-source.runtime.ts',
    name: 'isolationReported',
  },
  {
    because:
      'The data store per SQL-routed model, created once per process from the configuration and the model '
      + 'descriptor. Two replicas build the identical store over the identical table; the store itself keeps no '
      + 'data — every read and write goes to the database.',
    classification: 'derived',
    file: 'common/persistence/data-source.runtime.ts',
    name: 'stores',
  },
  {
    because:
      'The interval of one expiry sweep (expired rows of SQL tables, expired IAM sessions). Every replica runs its own '
      + 'timer, and that is the intended shape: with a SQL default source a lease in the shared lease table lets one '
      + 'replica per interval do the work, otherwise each one does — harmless, because a sweep deletes only what '
      + 'has already expired and every reader checks the expiry itself. Cleared on shutdown and unref-ed.',
    classification: 'bounded',
    file: 'common/persistence/expiry-sweep.ts',
    name: 'timer',
  },
  {
    because:
      'The SET assignments of ONE update being compiled. Created per compilation and discarded with it; it never '
      + 'outlives the statement it builds.',
    classification: 'bounded',
    file: 'common/persistence/sql/postgres/postgres-update.compiler.ts',
    name: 'assignments',
  },
  {
    because:
      'The SET assignments of ONE MySQL update being compiled. Created per compilation and discarded with it; it never '
      + 'outlives the statement it builds.',
    classification: 'bounded',
    file: 'common/persistence/sql/mysql/mysql-update.compiler.ts',
    name: 'assignments',
  },
  {
    because:
      'The nested JSON writes per column of ONE MySQL update being compiled, folded into one JSON_SET at the end of '
      + 'the compilation and discarded with it.',
    classification: 'bounded',
    file: 'common/persistence/sql/mysql/mysql-update.compiler.ts',
    name: 'nested',
  },
  {
    because:
      'The paths ONE MySQL update writes, to refuse two operators on one path. Lives for one compilation only.',
    classification: 'bounded',
    file: 'common/persistence/sql/mysql/mysql-update.compiler.ts',
    name: 'touched',
  },
  {
    because:
      'Column → field lookup of one store, computed in the constructor from the model descriptor. Every replica '
      + 'derives the same map from the same code.',
    classification: 'derived',
    file: 'common/persistence/sql/sql-data-store.ts',
    name: 'fields',
  },
  {
    because:
      'The names of the jobs this replica registered as BullMQ schedulers, from its own cron config. Replicas of one '
      + 'version derive the same set from the same code and config; the schedules themselves live in Redis. During a '
      + 'rolling deploy two versions disagree, which is why a scheduler a newer version removed carries a shared '
      + 'removal marker in Redis that restoreBullSchedulers() honours.',
    classification: 'derived',
    file: 'common/services/core-cron-jobs.service.ts',
    name: 'bullScheduledJobs',
  },
  {
    because:
      'The periodic check that the BullMQ schedules still exist in Redis. Every replica runs its own and they need '
      + 'not agree: each one only registers a schedule Redis no longer has, and two replicas doing that at once write '
      + 'the identical schedule. Cleared on shutdown and unref\'d, so it never holds the event loop open.',
    classification: 'local',
    file: 'common/services/core-cron-jobs.service.ts',
    name: 'bullSchedulerCheckTimer',
  },
  {
    because:
      'Subscriber callbacks — functions cannot be serialized, so they are local by definition. '
      + 'What crosses replicas is the MESSAGE, published through Redis; these maps only route it '
      + 'to the handlers registered in THIS process.',
    classification: 'local',
    file: 'common/services/core-redis-pubsub.ts',
    name: 'handlers',
  },
  {
    because: 'Bookkeeping for the shared subscriber connection; see `handlers` above.',
    classification: 'local',
    file: 'common/services/core-redis-pubsub.ts',
    name: 'subscriptions',
  },
  {
    because:
      'The channels THIS process subscribes on its own subscriber connection, counted per holder, so every `ready` '
      + 'of that connection can subscribe them again. A subscription belongs to a connection, so it is local by '
      + 'definition; what crosses replicas is the published message.',
    classification: 'local',
    file: 'common/services/core-redis.service.ts',
    name: 'subscribedChannels',
  },
  {
    because: 'Per-channel handler set; see `handlers` above.',
    classification: 'local',
    file: 'common/services/core-redis-pubsub.ts',
    name: 'channelHandlers',
  },
  {
    because: 'Model classes registered from code at boot. Identical in every replica.',
    classification: 'derived',
    file: 'common/services/model-registry.service.ts',
    name: 'models',
  },
  {
    because:
      'The FALLBACK counter. With `redis` configured the counters live in Redis '
      + '(RedisRateLimitStore) and the limit is exact across replicas; without it, each replica '
      + 'counts on its own — which is the documented pre-Redis behavior.',
    classification: 'shared',
    file: 'common/services/rate-limit-store.ts',
    name: 'store',
  },
  {
    because:
      'Fixed set of 64 coarse counters that keys beyond `maxEntries` are folded into, so a '
      + 'saturated store still enforces a limit instead of waving unknown keys through. Bounded by '
      + 'construction and shares the fate of `store`: per-replica only when Redis is absent, which '
      + 'is the documented pre-Redis behavior.',
    classification: 'shared',
    file: 'common/services/rate-limit-store.ts',
    name: 'overflow',
  },
  {
    because:
      'Eviction timer for the in-memory fallback above. unref\'d, and released via destroy() '
      + 'from each owner\'s onModuleDestroy.',
    classification: 'local',
    file: 'common/services/rate-limit-store.ts',
    name: 'cleanupInterval',
  },
  {
    because:
      'Which ioredis CONNECTIONS the hit script has been registered on via defineCommand — an '
      + 'attribute of a socket this process owns, so there is nothing for a second replica to '
      + 'agree with. Weak, so a discarded connection is not kept alive by the bookkeeping; a '
      + 'replica that has not registered yet simply registers on its first hit.',
    classification: 'local',
    file: 'common/services/rate-limit-store.ts',
    name: 'prepared',
  },
  {
    because:
      'Live Streamable-HTTP transports, each holding an open response stream — they cannot leave '
      + 'the process. The SESSION REGISTRY is shared through Redis so a mis-routed request gets an '
      + 'explicit answer naming the owning replica; /ai/mcp requires sticky sessions.',
    classification: 'local',
    file: 'modules/ai/core-ai-mcp.controller.ts',
    name: 'transports',
  },
  {
    because: 'Provider builder functions registered from code at boot.',
    classification: 'derived',
    file: 'modules/ai/providers/llm-provider.factory.ts',
    name: 'builders',
  },
  {
    because:
      'WeakMap keyed by a request-scoped object, so it lives and dies with the request that '
      + 'created it.',
    classification: 'bounded',
    file: 'modules/ai/services/core-ai-connection-resolver.service.ts',
    name: 'tenantPrefCache',
  },
  {
    because: 'Open MCP client connections — sockets cannot be shared between processes.',
    classification: 'local',
    file: 'modules/ai/services/core-ai-mcp-client.service.ts',
    name: 'registered',
  },
  {
    because: 'Placeholder resolvers registered from code at boot.',
    classification: 'derived',
    file: 'modules/ai/services/core-ai-placeholder.registry.ts',
    name: 'placeholders',
  },
  {
    because: 'Tools registered from code at boot; the same registry in every replica.',
    classification: 'derived',
    file: 'modules/ai/tools/ai-tool.registry.ts',
    name: 'tools',
  },
  {
    because:
      'The FALLBACK resend cooldown. With `redis` configured the slot is an atomic SET NX PX, so '
      + 'two replicas cannot both send; without it each replica counts on its own, exactly as before.',
    classification: 'shared',
    file: 'modules/better-auth/core-better-auth-email-verification.service.ts',
    name: 'lastSendTimes',
  },
  {
    because:
      'Cleanup timers for the fallback map above — cleared when a slot is released so a failed '
      + 'send can never expire a later cooldown early.',
    classification: 'local',
    file: 'modules/better-auth/core-better-auth-email-verification.service.ts',
    name: 'sendTimers',
  },
  {
    because:
      'Roles/verified for a session user, TTL 15s (0 under test). A role change is visible on '
      + 'every replica within that bound, and the bound is the same one a single replica always had.',
    classification: 'bounded',
    file: 'modules/better-auth/core-better-auth-user.mapper.ts',
    name: 'userCache',
  },
  {
    because: 'Translation strings loaded from files at boot.',
    classification: 'derived',
    file: 'modules/error-code/core-error-code.service.ts',
    name: 'translations',
  },
  {
    because: 'Memoized source resolution, recomputed per replica from the same inputs.',
    classification: 'derived',
    file: 'modules/hub/services/core-hub-sources.service.ts',
    name: 'resolveCache',
  },
  {
    because: 'Config-derived exclusion list, identical in every replica.',
    classification: 'derived',
    file: 'modules/hub/services/hub-log-buffer.service.ts',
    name: 'excludeContexts',
  },
  {
    because:
      'Commands currently in flight on THIS process\'s Mongo driver — they complete or fail here '
      + 'and nowhere else.',
    classification: 'local',
    file: 'modules/hub/services/hub-query-profiler.service.ts',
    name: 'pending',
  },
  {
    because: 'Config-derived ignore list, identical in every replica.',
    classification: 'derived',
    file: 'modules/hub/services/hub-query-profiler.service.ts',
    name: 'ignore',
  },
  {
    because:
      'Membership lookups, TTL-bounded (multiTenancy.cacheTtlMs, default 30s). With `redis` '
      + 'configured an explicit invalidation is BROADCAST to every replica, so a revoked membership '
      + 'does not linger anywhere; without it each replica expires on its own TTL.',
    classification: 'shared',
    file: 'modules/tenant/core-tenant.guard.ts',
    name: 'membershipCache',
  },
  {
    because: 'Tenant id lookups; same TTL and same invalidation broadcast as `membershipCache`.',
    classification: 'shared',
    file: 'modules/tenant/core-tenant.guard.ts',
    name: 'tenantIdsCache',
  },
  {
    because:
      'Answers of multiTenancy.isTenantActive, TTL-bounded like the caches above. invalidateTenant() '
      + 'BROADCASTS to every replica with `redis` configured, so a deactivated tenant is refused '
      + 'fleet-wide at once; without it each replica follows within cacheTtlMs.',
    classification: 'shared',
    file: 'modules/tenant/core-tenant.guard.ts',
    name: 'tenantActiveCache',
  },
  {
    because: 'Eviction timer for the caches above. unref\'d, and cleared in onModuleDestroy.',
    classification: 'local',
    file: 'modules/tenant/core-tenant.guard.ts',
    name: 'cleanupInterval',
  },
  {
    because:
      'The route a TUS controller class declared, remembered before forRoot() moves it to a configured '
      + 'tus.path. Read from decorator metadata at boot, so every replica holds the same value.',
    classification: 'derived',
    file: 'modules/tus/tus.module.ts',
    name: 'declaredPaths',
  },
  {
    because:
      'Expiry sweep for incomplete uploads. Cleared in onModuleDestroy. Every replica sweeps the '
      + 'same store, and the sweep is idempotent.',
    classification: 'local',
    file: 'modules/tus/core-tus.service.ts',
    name: 'cleanupInterval',
  },
  {
    because:
      'The stored file id per finished upload, for the X-File-Id header. WeakMap keyed by the Upload '
      + 'object @tus/server hands to onUploadFinish: onUploadComplete writes it and onUploadFinish reads '
      + 'it within the SAME request on the SAME replica, so a second replica never needs it — the header '
      + 'belongs to the response of the request that stored the file. Collected with that Upload object.',
    classification: 'bounded',
    file: 'modules/tus/core-tus.service.ts',
    name: 'storedFileIds',
  },
  {
    because:
      'Keeps THIS request\'s upload lock alive while it is being served. The lock itself lives in '
      + 'Redis and is exclusive across replicas; only the refresh timer for the request in flight '
      + 'is local, and it is cleared in unlock(). A holder that dies stops refreshing and the key '
      + 'expires, so the upload frees itself.',
    classification: 'local',
    file: 'modules/tus/tus-redis-locker.ts',
    name: 'heartbeat',
  },
  {
    because:
      'Heartbeat that keeps the migration lock alive while a migration runs. unref\'d, and stopped '
      + 'in the finally that releases the lock.',
    classification: 'local',
    file: 'modules/migrate/mongo-state-store.ts',
    name: 'timer',
  },
];

/** A state holder found in the source */
interface Detected {
  file: string;
  line: number;
  name: string;
  source: string;
}

/**
 * Collection held on an object (`x = new Map()`, `this.x = new Set()`), or a repeating timer.
 *
 * Deliberately NOT matching a `const`/`let` inside a function body: a collection built and dropped
 * within one call is not process state, and including those buries the real entries under dozens of
 * false positives — which is how an inventory like this stops being read.
 */
const PROPERTY_COLLECTION = /^\s{2,}(?:(?:private|protected|public|static|readonly|override|abstract)\s+)*([a-zA-Z_]\w*)\s*(?::[^=;]+)?=\s*new (?:Map|Set|WeakMap|WeakSet)\b/;
const ASSIGNED_COLLECTION = /^\s+this\.([a-zA-Z_]\w*)\s*=\s*new (?:Map|Set|WeakMap|WeakSet)\b/;
const REPEATING_TIMER = /^\s*(?:(?:const|let|var)\s+)?(?:this\.)?([a-zA-Z_]\w*)\s*=\s*setInterval\s*\(/;

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, acc);
    } else if (full.endsWith('.ts') && !full.endsWith('.d.ts') && !full.includes('.spec.')) {
      acc.push(full);
    }
  }
  return acc;
}

function detectStateHolders(): Detected[] {
  const found: Detected[] = [];
  for (const file of collectFiles(CORE_DIR)) {
    const relative = path.relative(CORE_DIR, file).split(path.sep).join('/');
    // Browser-side scripts the Hub serves as strings: they run in the visitor's tab, not here.
    if (relative.includes('hub/helpers/hub-client')) {
      continue;
    }
    fs.readFileSync(file, 'utf-8')
      .split('\n')
      .forEach((line, index) => {
        // A DEFAULT PARAMETER reads exactly like a property declaration but is created fresh on
        // every call, so it is not process state. It is distinguishable by the trailing comma that
        // separates it from the next parameter.
        if (line.trimEnd().endsWith(',')) {
          return;
        }
        const match = PROPERTY_COLLECTION.exec(line) ?? ASSIGNED_COLLECTION.exec(line) ?? REPEATING_TIMER.exec(line);
        if (match) {
          found.push({ file: relative, line: index + 1, name: match[1], source: line.trim() });
        }
      });
  }
  return found;
}

describe('statelessness invariants', () => {
  const detected = detectStateHolders();
  const key = (file: string, name: string) => `${file}#${name}`;
  const inventoryKeys = new Set(INVENTORY.map(entry => key(entry.file, entry.name)));
  const detectedKeys = new Set(detected.map(entry => key(entry.file, entry.name)));

  it('finds the state holders it is supposed to look at', () => {
    // A guard on the guard: if a refactor silently breaks the patterns, every other assertion
    // here passes vacuously while checking nothing at all.
    expect(detected.length).toBeGreaterThan(15);
  });

  it('classifies every process-local state holder in src/core', () => {
    const unclassified = detected
      .filter(entry => !inventoryKeys.has(key(entry.file, entry.name)))
      .map(entry => `${entry.file}:${entry.line}  ${entry.name}   ${entry.source}`);

    expect(
      unclassified,
      'New process-local state in src/core. Before this can merge, answer what a SECOND REPLICA does '
      + 'to it, then add an entry to INVENTORY in this file with that reasoning:\n'
      + '  shared  — lives in Redis when configured; the in-memory copy is a documented fallback\n'
      + '  derived — recomputed per replica from code/config/DB, so replicas cannot disagree\n'
      + '  bounded — genuinely divergent, but only within a stated bound (a TTL, a request)\n'
      + '  local   — holds something that cannot leave the process (a socket, a live transport)\n',
    ).toEqual([]);
  });

  it('has no stale inventory entries', () => {
    const stale = INVENTORY.filter(entry => !detectedKeys.has(key(entry.file, entry.name))).map(
      entry => `${entry.file}#${entry.name}`,
    );

    expect(stale, 'These are listed but no longer exist — remove them so the inventory stays true').toEqual([]);
  });

  it('gives every entry a real reason', () => {
    const thin = INVENTORY.filter(entry => entry.because.trim().length < 40).map(entry => entry.file + '#' + entry.name);

    expect(thin, 'A classification without a reason is not a decision anyone can review').toEqual([]);
  });

  it('keeps every `shared` entry next to a distributed path', () => {
    // A `shared` claim means the file itself reaches for Redis. If it stops doing that, the entry
    // has quietly become a plain local cache while still claiming otherwise.
    const broken = INVENTORY.filter(entry => entry.classification === 'shared').filter((entry) => {
      const source = fs.readFileSync(path.join(CORE_DIR, entry.file), 'utf-8');
      return !/CoreRedisService|RedisRateLimitStore|redisService/.test(source);
    });

    expect(
      broken.map(entry => entry.file + '#' + entry.name),
      'Classified `shared`, but the file no longer references a distributed store',
    ).toEqual([]);
  });
});
