#!/usr/bin/env bash
set -e

# Temp file for server output
LOG_FILE=$(mktemp)

# Start server in background, redirect output to log file
NODE_ENV=local node dist/main.js > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# Show log output in real-time
tail -f "$LOG_FILE" &
TAIL_PID=$!

# Ensure cleanup on exit: kill server, tail, and remove temp file
trap 'kill $SERVER_PID $TAIL_PID 2>/dev/null; wait $SERVER_PID $TAIL_PID 2>/dev/null || true; rm -f "$LOG_FILE"' EXIT

# Wait for the actual "Server startet at" log line from main.ts (max 60 seconds)
for i in $(seq 1 60); do
  if grep -q "Server startet at" "$LOG_FILE" 2>/dev/null; then
    echo ""
    echo "Server started successfully - check complete"
    exit 0
  fi
  # Check if server process died unexpectedly
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo ""
    echo "Server process exited unexpectedly"
    exit 1
  fi
  sleep 1
done

echo ""
echo "Server failed to start within 60 seconds"
exit 1
