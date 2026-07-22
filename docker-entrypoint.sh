#!/bin/sh
# Docker entrypoint for the API container.
#
# Runs pending database migrations before starting the NestJS server.
#
# Migrations are compiled to JavaScript by `pnpm run build` (tsconfig.build.json includes
# migrations/ + migrations-utils/), so the production image runs them without a TypeScript
# transpiler — ts-node is a devDependency and gets pruned.
#
# The migrate CLI is looked up in both supported layouts:
#   npm mode     /app/node_modules/.bin/migrate  (bin of @lenne.tech/nest-server)
#   vendor mode  $DIST/bin/migrate.js            (shim copied into dist by copy:bin)
#
# NOTHING-TO-DO is not a failure — skip instead of crash-looping the container:
#   - No migrations bundled? A fresh database gets schema and indexes from Mongoose at boot,
#     and first-run is handled by the SystemSetup module.
#   - No CLI in the image? Skip.
#
# A migration that RUNS AND FAILS *is* a failure, and this entrypoint aborts on it.
# This deliberately differs from nest-server-starter, which degrades it to a warning and starts
# anyway. Rationale: serving against a half-applied schema is how silent data corruption happens,
# and the container runtime restarts and retries regardless. Availability-first deployments can
# opt out with MIGRATE_FAILURE_POLICY=warn.
#
# Test seams (default to the real values in the container):
#   APP_DIST                compiled output (/app/projects/api/dist in a monorepo, /app/dist standalone)
#   MIGRATE_BIN             path to the npm-mode migrate CLI (overridden in unit tests)
#   SERVER_CMD              command used to start the server (overridden in unit tests)
#   MIGRATE_FAILURE_POLICY  `abort` (default) or `warn`
set -e

DIST="${APP_DIST:-/app/dist}"
MIGRATE_BIN="${MIGRATE_BIN:-/app/node_modules/.bin/migrate}"
VENDOR_MIGRATE="$DIST/bin/migrate.js"
MIGRATE_FAILURE_POLICY="${MIGRATE_FAILURE_POLICY:-abort}"

run_migrations() {
  if "$@" up --store "$DIST/migrations-utils/migrate.js" --migrations-dir "$DIST/migrations"; then
    echo "[entrypoint] Migrations applied."
  elif [ "$MIGRATE_FAILURE_POLICY" = "warn" ]; then
    echo "[entrypoint] WARNING: migration step failed — continuing to start server (MIGRATE_FAILURE_POLICY=warn)."
  else
    echo "[entrypoint] ERROR: migration step failed — refusing to start against a possibly half-applied schema."
    echo "[entrypoint] Set MIGRATE_FAILURE_POLICY=warn to start anyway."
    exit 1
  fi
}

echo "[entrypoint] Database migrations..."
if [ ! -d "$DIST/migrations" ] || [ -z "$(ls -A "$DIST/migrations" 2>/dev/null)" ]; then
  echo "[entrypoint] no migrations bundled — skipping migrations."
elif [ -x "$MIGRATE_BIN" ]; then
  run_migrations "$MIGRATE_BIN"
elif [ -f "$VENDOR_MIGRATE" ]; then
  run_migrations node "$VENDOR_MIGRATE"
else
  echo "[entrypoint] migrate CLI not present in image — skipping migrations."
fi

# The entry point differs by build layout, and guessing wrong yields a bare MODULE_NOT_FOUND plus a
# healthcheck timeout — an expensive way to learn about a path. This repo's own build emits
# dist/main.js; the starter (whose tsconfig rootDir spans migrations/ too) emits dist/src/main.js.
if [ -z "$SERVER_CMD" ]; then
  if [ -f "$DIST/src/main.js" ]; then
    SERVER_CMD="node $DIST/src/main.js"
  elif [ -f "$DIST/main.js" ]; then
    SERVER_CMD="node $DIST/main.js"
  else
    echo "[entrypoint] ERROR: no server entry point found ($DIST/src/main.js or $DIST/main.js)."
    exit 1
  fi
fi

# NOTE: no NODE_OPTIONS=--max-old-space-size here, and that is DELIBERATE.
# Node sizes its default heap from the cgroup memory limit (uv_get_constrained_memory) — but only
# while the flag is UNSET. Pinning a literal disables that auto-sizing, so on a memory-limited
# container the cgroup OOM-killer (SIGKILL, exit 137, no stacktrace) fires before V8's own graceful
# "JavaScript heap out of memory" FATAL. That undiagnosable death is exactly what the process
# diagnostics exist to eliminate. If you ever genuinely need a ceiling, DERIVE it from the container
# limit (~75%), never hardcode one. See docs/REQUEST-LIFECYCLE.md -> Process Diagnostics.

echo "[entrypoint] Starting server..."
exec $SERVER_CMD
