# BetterAuth IAM Load Tests

k6-based load tests for the BetterAuth IAM module of `@lenne.tech/nest-server`.

## Prerequisites

```bash
# Install k6
brew install k6

# Build the server
npm run build

# Ensure MongoDB is running on localhost:27017
```

## Quick Start

```bash
# Start server in one terminal
npm start

# Run all load tests in another terminal
./load-tests/run.sh

# Or start server automatically
./load-tests/run.sh --with-server
```

## Available Tests

| Test | File | VUs | Duration | What it measures |
|------|------|-----|----------|------------------|
| **Sign-In** | `iam-sign-in.k6.js` | 50 | 80s | Sign-in endpoint latency |
| **GraphQL JWT** | `iam-graphql-jwt.k6.js` | 100 | 140s | JWT auth middleware overhead |
| **Session** | `iam-session.k6.js` | 50 | 80s | Session cookie / DB lookup |
| **Memory Soak** | `iam-memory-soak.k6.js` | 20 | 10 min | Memory leak detection |

## Running Individual Tests

```bash
# Run a single test directly
k6 run load-tests/iam-sign-in.k6.js

# Via runner (partial name match)
./load-tests/run.sh sign-in
./load-tests/run.sh graphql
./load-tests/run.sh session
./load-tests/run.sh memory-soak

# Custom base URL
BASE_URL=http://staging.example.com:3000 k6 run load-tests/iam-sign-in.k6.js
```

## Memory Soak Test

The memory soak test is excluded from the default run because it takes 10 minutes.

```bash
# Run soak test
./load-tests/run.sh memory-soak

# Monitor memory in a separate terminal
./load-tests/monitor-memory.sh

# Or with specific PID and interval
./load-tests/monitor-memory.sh <pid> 5
```

The memory monitor outputs a CSV file in `load-tests/results/` for later analysis.

## Results

Test results are saved as JSON in `load-tests/results/`:

```
load-tests/results/
  iam-sign-in-20250206-143022.json
  iam-graphql-jwt-20250206-143022.json
  memory-20250206-143022.csv
```

## Thresholds

Each test defines pass/fail thresholds:

| Test | Metric | p95 Target | p99 Target | Success Rate |
|------|--------|------------|------------|-------------|
| Sign-In | `iam_sign_in_duration` | < 2000ms | < 5000ms | > 95% |
| GraphQL JWT | `gql_jwt_duration` | < 1000ms | < 3000ms | > 95% |
| Session | `iam_session_duration` | < 1500ms | < 4000ms | > 95% |

## Suspected Bottlenecks

These tests target the following suspected performance issues:

| Test | Bottleneck | Code Location |
|------|-----------|---------------|
| Sign-In | DB queries per request | `core-better-auth.service.ts` |
| GraphQL JWT | JWKS key import per request | `core-better-auth-token.service.ts` |
| GraphQL JWT | HS256 key re-derivation | `core-better-auth-token.service.ts` |
| Session | MongoDB aggregation pipeline | `core-better-auth.service.ts` |
| Memory Soak | Unbounded rate limiter Map | `core-better-auth-rate-limiter.service.ts` |
| Memory Soak | Unbounded email verification Map | `core-better-auth-email-verification.service.ts` |
