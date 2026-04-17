# Production Dockerfile for nest-server-starter projects.
# Works in both standalone and monorepo (lt fullstack init) setups.
#
# Standalone:  docker build -t api .
# Monorepo:    docker build --build-arg API_DIR=projects/api -t api .
#              (build context = monorepo root)

ARG API_DIR=.

# Stage 1: Install dependencies
FROM node:22-alpine@sha256:8094c002d08262dba12645a3b4a15cd6cd627d30bc782f53229a2ec13ee22a00 AS deps
WORKDIR /app

# Build tools for bcrypt native addon
RUN apk add --no-cache python3 make g++ && corepack enable

# Copy all manifests for dependency resolution.
# In monorepo mode pnpm needs workspace config + all project manifests;
# copying everything and then installing is the simplest cross-mode approach.
COPY . /tmp/src
RUN find /tmp/src -maxdepth 3 -name "package.json" -not -path "*/node_modules/*" \
      -exec sh -c 'dir=$(dirname "$1" | sed "s|^/tmp/src|.|"); mkdir -p "/app/$dir"; cp "$1" "/app/$dir/"' _ {} \; \
    && cp -f /tmp/src/pnpm-lock.yaml /app/ 2>/dev/null || true \
    && cp -f /tmp/src/pnpm-workspace.yaml /app/ 2>/dev/null || true \
    && cp -f /tmp/src/.npmrc /app/ 2>/dev/null || true \
    && rm -rf /tmp/src

# Install dependencies (--ignore-scripts prevents husky/prepare errors in Docker)
# Rebuild bcrypt native addon separately
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild bcrypt

# Stage 2: Build
FROM node:22-alpine@sha256:8094c002d08262dba12645a3b4a15cd6cd627d30bc782f53229a2ec13ee22a00 AS builder
ARG API_DIR=.
WORKDIR /app
RUN corepack enable

COPY --from=deps /app ./
COPY ${API_DIR}/ ./${API_DIR}/

RUN cd ${API_DIR} && pnpm run build

# Remove devDependencies after build
RUN CI=true pnpm install --frozen-lockfile --prod --ignore-scripts

# Stage 3: Production runner
FROM node:22-alpine@sha256:8094c002d08262dba12645a3b4a15cd6cd627d30bc782f53229a2ec13ee22a00
ARG API_DIR=.
WORKDIR /app
ENV NODE_ENV=production

# Non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

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

ENTRYPOINT ["/app/docker-entrypoint.sh"]
