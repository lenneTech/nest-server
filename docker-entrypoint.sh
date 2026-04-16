#!/bin/sh
# Docker entrypoint for the API container.
# Runs pending database migrations before starting the NestJS server.
# The migrate CLI and store are copied to dist/ at build time (see copy:migrations).
set -e

echo "[entrypoint] Running database migrations..."
node /app/node_modules/.bin/migrate up \
  --store /app/dist/migrations-utils/migrate.js \
  --migrations-dir /app/dist/migrations

echo "[entrypoint] Starting server..."
exec node /app/dist/src/main.js
