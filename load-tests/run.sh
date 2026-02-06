#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# k6 Load Test Runner for BetterAuth IAM
#
# Usage:
#   ./load-tests/run.sh              # run all tests (server must be running)
#   ./load-tests/run.sh --with-server # start server, run tests, stop server
#   ./load-tests/run.sh sign-in      # run a single test
# ---------------------------------------------------------------------------

set -euo pipefail
cd "$(dirname "$0")/.."

RESULTS_DIR="load-tests/results"
mkdir -p "$RESULTS_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log()  { echo -e "${GREEN}[k6]${NC} $*"; }
warn() { echo -e "${YELLOW}[k6]${NC} $*"; }
err()  { echo -e "${RED}[k6]${NC} $*"; }

# ---------------------------------------------------------------------------
# Check prerequisites
# ---------------------------------------------------------------------------

if ! command -v k6 &> /dev/null; then
  err "k6 is not installed.  Install via: brew install k6"
  exit 1
fi

# ---------------------------------------------------------------------------
# Optionally start the server
# ---------------------------------------------------------------------------

SERVER_PID=""
WITH_SERVER=false

for arg in "$@"; do
  if [[ "$arg" == "--with-server" ]]; then
    WITH_SERVER=true
  fi
done

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    log "Stopping server (PID $SERVER_PID) ..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    log "Server stopped."
  fi
}
trap cleanup EXIT

if $WITH_SERVER; then
  log "Starting nest-server in CI mode (rate limit disabled for load testing) ..."
  NODE_ENV=ci NSC__betterAuth__rateLimit__enabled=false node dist/main.js &
  SERVER_PID=$!

  # Wait for health-check
  log "Waiting for server to become healthy ..."
  for i in $(seq 1 60); do
    if curl -s http://127.0.0.1:3000/health > /dev/null 2>&1; then
      log "Server is healthy."
      break
    fi
    if [[ $i -eq 60 ]]; then
      err "Server did not become healthy within 60 seconds."
      exit 1
    fi
    sleep 1
  done
fi

# ---------------------------------------------------------------------------
# Determine which tests to run
# ---------------------------------------------------------------------------

ALL_TESTS=(
  "iam-sign-in"
  "iam-graphql-jwt"
  "iam-session"
  "iam-memory-soak"
)

TESTS_TO_RUN=()

for arg in "$@"; do
  [[ "$arg" == "--with-server" ]] && continue
  # Match partial name
  for t in "${ALL_TESTS[@]}"; do
    if [[ "$t" == *"$arg"* ]]; then
      TESTS_TO_RUN+=("$t")
    fi
  done
done

# Default: all tests (except memory soak unless explicitly requested)
if [[ ${#TESTS_TO_RUN[@]} -eq 0 ]]; then
  TESTS_TO_RUN=("iam-sign-in" "iam-graphql-jwt" "iam-session")
  warn "Skipping memory soak test (10 min). Run explicitly: ./load-tests/run.sh memory-soak"
fi

# ---------------------------------------------------------------------------
# Run tests
# ---------------------------------------------------------------------------

FAILED=0

for test in "${TESTS_TO_RUN[@]}"; do
  SCRIPT="load-tests/${test}.k6.js"
  RESULT_FILE="${RESULTS_DIR}/${test}-${TIMESTAMP}.json"

  if [[ ! -f "$SCRIPT" ]]; then
    err "Test script not found: $SCRIPT"
    FAILED=$((FAILED + 1))
    continue
  fi

  log "Running: $test"
  log "Results: $RESULT_FILE"

  if k6 run \
    --out "json=$RESULT_FILE" \
    --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
    "$SCRIPT"; then
    log "$test: PASSED"
  else
    err "$test: FAILED (thresholds not met)"
    FAILED=$((FAILED + 1))
  fi

  echo ""
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
if [[ $FAILED -eq 0 ]]; then
  log "All ${#TESTS_TO_RUN[@]} tests passed."
else
  err "$FAILED of ${#TESTS_TO_RUN[@]} tests failed."
  exit 1
fi
