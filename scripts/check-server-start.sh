#!/usr/bin/env bash
# Start the built server against a free port, verify the "Server startet at …"
# log line, then exit cleanly.
#
# Previously this script also streamed logs via a parallel `tail -f` and waited
# on both PIDs on EXIT. On macOS / bash that pattern hangs intermittently:
# `tail -f` does not always honor SIGTERM while blocked on the kqueue file
# watch, so `wait $TAIL_PID` blocks indefinitely and the surrounding
# `pnpm run check` never returns. We now skip the live stream and print the
# relevant log excerpt at the end instead.

set -e

LOG_FILE=$(mktemp -t nest-server-check.XXXXXX)

# Pick a free port so the check does not fail when the default port is
# busy. Strip ANSI color escape sequences from the command output —
# when this script runs under a workspace runner like lerna/nx, stdout
# may be wrapped and color codes ("\x1b[33m...\x1b[39m") injected.
# Those would land inside FREE_PORT and crash net.Server#listen with
# `ERR_SOCKET_BAD_PORT options.port ... Received type string ('<codes>50604<codes>')`.
# A naïve `tr -cd '0-9'` makes it worse because the color codes contain
# digits (33, 39) themselves; sed only on the escape pattern keeps the
# port digits intact.
FREE_PORT=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>console.log(p));});" | sed $'s/\x1b\\[[0-9;]*m//g' | tr -d '[:space:]')
echo "Using free port: $FREE_PORT"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    # SIGTERM first, then SIGKILL if still alive after ~2s. We do NOT `wait`
    # on the child — it was the original hang. Nitro/Nest can take a moment
    # to unwind its listeners; the escalation gives it that moment.
    kill "$SERVER_PID" 2>/dev/null || true
    for _ in 1 2 3 4; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$LOG_FILE"
}
trap cleanup EXIT

NSC__PORT=$FREE_PORT NODE_ENV=local node dist/main.js >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
# Remove from job table so bash does not print "Terminated: 15" on SIGTERM
disown "$SERVER_PID" 2>/dev/null || true

for _ in $(seq 1 60); do
  if grep -q "Server startet at" "$LOG_FILE" 2>/dev/null; then
    tail -n 5 "$LOG_FILE"
    echo "Server started successfully - check complete"
    exit 0
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server process exited unexpectedly. Full log:"
    cat "$LOG_FILE"
    exit 1
  fi
  sleep 1
done

echo "Server failed to start within 60 seconds. Last 30 log lines:"
tail -n 30 "$LOG_FILE"
exit 1
