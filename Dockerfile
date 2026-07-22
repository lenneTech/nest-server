# Production Dockerfile for nest-server-starter projects.
# Works in both standalone and monorepo (lt fullstack init) setups.
#
# Standalone:  docker build -t api .
# Monorepo:    docker build --build-arg API_DIR=projects/api -t api .
#              (build context = monorepo root)

ARG API_DIR=.

# Stage 1: Install dependencies
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS deps
WORKDIR /app

# Build tools for bcrypt native addon
RUN apk add --no-cache python3 make g++

# Copy all manifests for dependency resolution.
# In monorepo mode pnpm needs workspace config + all project manifests;
# copying everything and then installing is the simplest cross-mode approach.
COPY . /tmp/src
# pnpm-lock.yaml and pnpm-workspace.yaml are REQUIRED — the lockfile pins every version and the
# workspace file carries the security `overrides:`. A previous version chained `|| true` across the
# whole `&&` list, so a failed copy of either still exited 0 and the image silently built without
# them. Only .npmrc is genuinely optional, so only that one may fail.
RUN set -e; \
    find /tmp/src -maxdepth 3 -name "package.json" -not -path "*/node_modules/*" \
      -exec sh -c 'dir=$(dirname "$1" | sed "s|^/tmp/src|.|"); mkdir -p "/app/$dir"; cp "$1" "/app/$dir/"' _ {} \; ; \
    cp -f /tmp/src/pnpm-lock.yaml /app/; \
    cp -f /tmp/src/pnpm-workspace.yaml /app/; \
    if [ -f /tmp/src/.npmrc ]; then cp -f /tmp/src/.npmrc /app/; fi; \
    rm -rf /tmp/src

# Provision the exact pnpm declared in package.json (single source of truth).
# No corepack: Node >= 25 no longer ships it. The +sha512 suffix is stripped;
# npm enforces registry integrity for the tarball itself.
RUN npm install -g "$(node -p "require('./package.json').packageManager.split('+')[0]")"

# Install dependencies (--ignore-scripts prevents husky/prepare errors in Docker)
# Rebuild bcrypt native addon separately
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild bcrypt

# Stage 2: Build
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder
ARG API_DIR=.
WORKDIR /app

COPY --from=deps /app ./
COPY ${API_DIR}/ ./${API_DIR}/

# Provision the exact pnpm declared in package.json (single source of truth).
# No corepack: Node >= 25 no longer ships it. The +sha512 suffix is stripped;
# npm enforces registry integrity for the tarball itself.
RUN npm install -g "$(node -p "require('./package.json').packageManager.split('+')[0]")"

RUN cd ${API_DIR} && pnpm run build

# Remove devDependencies after build
RUN CI=true pnpm install --frozen-lockfile --prod --ignore-scripts

# Stage 3: Production runner
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
ARG API_DIR=.
WORKDIR /app
ENV NODE_ENV=production

# Non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# tini as PID 1. Without a real init, node itself becomes PID 1 — and a PID-namespace init is
# SIGNAL_UNKILLABLE, so a default-disposition signal sent from userspace is silently discarded by
# the kernel. The listening HTTP server keeps the event loop busy, so `docker stop` then waits out
# its whole grace period and SIGKILLs: in-flight requests dropped, every onModuleDestroy() skipped.
# tini forwards signals properly and reaps orphans. (`server.enableShutdownHooks()` in main.ts is
# the other half — it is what actually drains the loop.)
RUN apk add --no-cache tini

# Create writable directories for runtime files (TUS uploads, GraphQL schema)
RUN mkdir -p /app/uploads && chown -R nodejs:nodejs /app

# Copy built application and production-only dependencies
COPY --from=builder --chown=nodejs:nodejs /app/${API_DIR}/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/${API_DIR}/package.json ./
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs --chmod=755 ./${API_DIR}/docker-entrypoint.sh /app/docker-entrypoint.sh

USER nodejs
EXPOSE 3000

# Container healthcheck — uses the framework's HealthCheckModule (enabled via config.healthCheck).
# Orchestrators (Docker Swarm, Kubernetes, docker-compose) can leverage this to detect
# unhealthy containers and restart them. Adjust interval/timeout via --health-* flags at runtime.
# The endpoint is GET /health-check (see CoreHealthCheckController).
# start-period=60s accommodates cold-start with migrations, Mongo connection, and index creation.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health-check || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]
