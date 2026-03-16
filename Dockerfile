# Stage 1: Install dependencies
FROM node:22-alpine@sha256:8094c002d08262dba12645a3b4a15cd6cd627d30bc782f53229a2ec13ee22a00 AS deps
WORKDIR /app

# Build tools for bcrypt native addon
RUN apk add --no-cache python3 make g++ && corepack enable

# Copy workspace configuration
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# Copy all project manifests (required for pnpm workspace resolution)
COPY projects/api/package.json ./projects/api/
COPY projects/app/package.json ./projects/app/

# Install dependencies (--ignore-scripts prevents husky/prepare errors in Docker)
# Rebuild bcrypt native addon separately
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild bcrypt

# Stage 2: Build
FROM node:22-alpine@sha256:8094c002d08262dba12645a3b4a15cd6cd627d30bc782f53229a2ec13ee22a00 AS builder
WORKDIR /app
RUN corepack enable

COPY --from=deps /app ./
COPY projects/api/ ./projects/api/

RUN pnpm --filter @lenne.tech/nest-server-starter run build

# Remove devDependencies after build
RUN CI=true pnpm install --frozen-lockfile --prod --ignore-scripts

# Stage 3: Production runner
FROM node:22-alpine@sha256:8094c002d08262dba12645a3b4a15cd6cd627d30bc782f53229a2ec13ee22a00
WORKDIR /app
ENV NODE_ENV=production

# Non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Create writable directories for runtime files (TUS uploads, GraphQL schema)
RUN mkdir -p /app/uploads && chown -R nodejs:nodejs /app

# Copy built application and production-only dependencies
COPY --from=builder --chown=nodejs:nodejs /app/projects/api/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/projects/api/package.json ./
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules

USER nodejs
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
