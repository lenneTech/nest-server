#!/bin/bash
# Memory Load Test Runner
#
# Starts the nest-server, runs k6 load test, and monitors memory usage.
# Compares the memory footprint under sustained load with multi-tenancy active.
#
# Usage:
#   ./tests/k6/memory-test.sh              # Default: 15 VUs, 60s
#   ./tests/k6/memory-test.sh 50 120s      # Custom: 50 VUs, 120s
#
# Prerequisites:
#   - k6 installed (brew install k6)
#   - MongoDB running on localhost:27017
#   - pnpm run build completed

set -e

VUS=${1:-15}
DURATION=${2:-60s}
PORT=3000
LOG_FILE="/tmp/k6-memory-test-$(date +%s).log"
MEM_FILE="/tmp/k6-memory-samples-$(date +%s).csv"

echo "=== nest-server Memory Load Test ==="
echo "VUs: $VUS | Duration: $DURATION | Port: $PORT"
echo "Log: $LOG_FILE | Memory: $MEM_FILE"
echo ""

# Build if needed
if [ ! -d "dist" ]; then
  echo "Building..."
  pnpm run build
fi

# Kill any existing server on the test port
lsof -ti :$PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

# Start server in background
echo "Starting server on port $PORT..."
NODE_ENV=local PORT=$PORT node dist/main.js > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# Wait for server to be ready
echo "Waiting for server to start..."
for i in $(seq 1 30); do
  if curl -s "http://localhost:$PORT/health-check" > /dev/null 2>&1; then
    echo "Server ready (PID: $SERVER_PID)"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "ERROR: Server failed to start. Check $LOG_FILE"
    kill $SERVER_PID 2>/dev/null
    exit 1
  fi
  sleep 1
done

# Record initial memory
INITIAL_RSS=$(ps -o rss= -p $SERVER_PID | tr -d ' ')
echo "Initial RSS: $((INITIAL_RSS / 1024)) MB"
echo "timestamp_s,rss_mb,vsz_mb" > "$MEM_FILE"

# Start memory sampler in background
(
  START=$(date +%s)
  while kill -0 $SERVER_PID 2>/dev/null; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - START))
    RSS=$(ps -o rss= -p $SERVER_PID 2>/dev/null | tr -d ' ')
    VSZ=$(ps -o vsz= -p $SERVER_PID 2>/dev/null | tr -d ' ')
    if [ -n "$RSS" ]; then
      echo "$ELAPSED,$((RSS / 1024)),$((VSZ / 1024))" >> "$MEM_FILE"
    fi
    sleep 2
  done
) &
SAMPLER_PID=$!

echo ""
echo "Running k6 load test..."
echo "---"

# Run k6
k6 run \
  --env BASE_URL="http://localhost:$PORT" \
  --env VUS="$VUS" \
  --env DURATION="$DURATION" \
  tests/k6/memory-test.js 2>&1 || true

echo "---"
echo ""

# Record final memory
FINAL_RSS=$(ps -o rss= -p $SERVER_PID 2>/dev/null | tr -d ' ')
if [ -n "$FINAL_RSS" ]; then
  echo "=== Memory Results ==="
  echo "Initial RSS: $((INITIAL_RSS / 1024)) MB"
  echo "Final RSS:   $((FINAL_RSS / 1024)) MB"
  echo "Growth:      $(( (FINAL_RSS - INITIAL_RSS) / 1024 )) MB"
  echo ""
  echo "Memory samples saved to: $MEM_FILE"

  # Show peak
  PEAK=$(awk -F',' 'NR>1 {if($2>max)max=$2} END{print max}' "$MEM_FILE")
  echo "Peak RSS:    ${PEAK} MB"
fi

# Cleanup
echo ""
echo "Stopping server..."
kill $SERVER_PID 2>/dev/null
kill $SAMPLER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
wait $SAMPLER_PID 2>/dev/null

echo "Done. Server log: $LOG_FILE"
