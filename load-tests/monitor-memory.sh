#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Memory Monitor for Soak Tests
#
# Usage:
#   ./load-tests/monitor-memory.sh              # auto-detect node PID
#   ./load-tests/monitor-memory.sh <pid>         # monitor specific PID
#   ./load-tests/monitor-memory.sh <pid> 5       # custom interval (seconds)
# ---------------------------------------------------------------------------

set -euo pipefail

PID="${1:-}"
INTERVAL="${2:-2}"
LOG_FILE="load-tests/results/memory-$(date +%Y%m%d-%H%M%S).csv"

mkdir -p "$(dirname "$LOG_FILE")"

# Auto-detect server PID
if [[ -z "$PID" ]]; then
  PID=$(pgrep -f "node.*dist/main" 2>/dev/null | head -1 || true)
  if [[ -z "$PID" ]]; then
    PID=$(pgrep -f "node.*nest-server" 2>/dev/null | head -1 || true)
  fi
  if [[ -z "$PID" ]]; then
    echo "Could not auto-detect server PID. Pass it as argument."
    exit 1
  fi
  echo "Auto-detected server PID: $PID"
fi

echo "Monitoring PID $PID every ${INTERVAL}s → $LOG_FILE"
echo "Press Ctrl+C to stop."
echo ""

# CSV header
echo "timestamp,rss_kb,vsz_kb,elapsed_s" > "$LOG_FILE"

START=$(date +%s)

while kill -0 "$PID" 2>/dev/null; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - START))

  # RSS and VSZ in KB
  MEM=$(ps -o rss=,vsz= -p "$PID" 2>/dev/null || true)
  if [[ -z "$MEM" ]]; then
    echo "Process $PID exited."
    break
  fi

  RSS=$(echo "$MEM" | awk '{print $1}')
  VSZ=$(echo "$MEM" | awk '{print $2}')
  RSS_MB=$((RSS / 1024))

  echo "${ELAPSED}s  RSS: ${RSS_MB} MB  (${RSS} KB)"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ),${RSS},${VSZ},${ELAPSED}" >> "$LOG_FILE"

  sleep "$INTERVAL"
done

echo ""
echo "Memory log saved to: $LOG_FILE"
