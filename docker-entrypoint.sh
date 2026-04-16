#!/bin/sh
# Docker entrypoint for the API container.
# Runs pending database migrations before starting the NestJS server.
# Migrations are compiled to dist/migrations/ at build time; the migrate
# store and CLI are vendored from src/core/modules/migrate/.
set -e

echo "[entrypoint] Running database migrations..."
node /app/dist/src/core/modules/migrate/cli/migrate-cli.js up \
  --store /app/dist/migrations-utils/migrate.js \
  --migrations-dir /app/dist/migrations

echo "[entrypoint] Starting server..."
exec node /app/dist/src/main.js
